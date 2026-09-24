<script setup lang="ts">
import { EditorContent, useEditor } from '@tiptap/vue-3'
import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { computed, onBeforeUnmount, ref } from 'vue'
import type { WebsocketProvider } from 'y-websocket'
import type * as Y from 'yjs'

import { tryCopyText } from '../clipboard'
import { editorExtensions } from './extensions'
import { GUTTER_WIDTH, useParagraphSelection } from './paragraphSelection'
import { usePresence } from './presence'

const props = defineProps<{
  doc: Y.Doc
  /** 会话已有的网络 Provider：协作光标复用它的 Awareness，不另建连接。 */
  provider: WebsocketProvider
  /** 当前是否已连接同步服务；断网时隐藏远端覆盖层。 */
  connected: boolean
}>()

const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
const copyFallback = ref<string | null>(null)

/** 包住正文与覆盖层的非滚动相对容器：覆盖层的坐标以它为原点。 */
const surface = ref<HTMLElement | null>(null)

/**
 * 把一段纯文本转成行内内容，换行还原成 HardBreak。
 *
 * 用于重建粘贴位置前后的既有内容，避免把段内的软换行压成字面换行。
 */
function inlineNodes(schema: Schema, text: string): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = []
  text.split('\n').forEach((part, index) => {
    if (index > 0) nodes.push(schema.node('hardBreak'))
    if (part.length > 0) nodes.push(schema.text(part))
  })
  return nodes
}

/**
 * 编辑器只在正文根结构就绪后挂载：挂载过早会让 y-tiptap 依据空文档补一份默认
 * 段落，等于每个客户端都往共享文档里塞一次初始化内容。
 */
const editor = useEditor({
  extensions: editorExtensions(props.doc, props.provider),
  editorProps: {
    attributes: {
      class: 'editor-body',
      role: 'textbox',
      'aria-label': '文档正文',
      'aria-multiline': 'true',
      spellcheck: 'false',
    },
    /**
     * 粘贴只取 text/plain，并按内容与选区决定插入方式。
     *
     * ProseMirror 默认在剪贴板同时提供 HTML 与纯文本时优先用 HTML；这里显式改用
     * 纯文本，不经过 innerHTML。
     *
     * 两个容易出错的点：
     * 1. 不能把任何粘贴都当成「完整段落」：在 ab|cd 处粘贴 X 必须是 abXcd。
     * 2. 全选（Ctrl+A）时选区跨越整个文档，段落边界取不到，直接算会抛
     *    「There is no position before the top-level node」。
     * 另外粘贴之后必须显式给出光标位置，否则接着输入会错位或覆盖刚粘贴的内容。
     */
    handlePaste: (view, event) => {
      const clipboard = (event as ClipboardEvent).clipboardData
      if (!clipboard) return false
      const text = clipboard.getData('text/plain')
      if (text.length === 0) return false

      const normalized = text.replace(/\r\n?/g, '\n')
      const { state, dispatch } = view
      const { from, to, $from, $to } = state.selection
      const { schema } = state

      // 选区完全落在一个文本块内时，单行内容按行内插入处理。
      const insideOneBlock = $from.depth > 0 && $to.depth > 0 && $from.sameParent($to)
      if (!normalized.includes('\n') && insideOneBlock) {
        const tr = state.tr.insertText(normalized, from, to)
        // 光标落在插入内容之后，接着输入才是接着写而不是覆盖。
        tr.setSelection(TextSelection.create(tr.doc, from + normalized.length))
        dispatch(tr.scrollIntoView())
        return true
      }

      // 其余情况按段落替换处理。
      //
      // 深度为 0 说明选区跨越整个文档（例如 Ctrl+A 的全选）：此时没有段落边界可
      // 依据，直接使用选区边界，也没有前后缀需要保留。
      const atTopLevel = $from.depth === 0 || $to.depth === 0
      const start = atTopLevel ? from : $from.before($from.depth)
      const end = atTopLevel ? to : $to.after($to.depth)
      const prefix = atTopLevel
        ? ''
        : $from.parent.textBetween(0, $from.parentOffset, undefined, '\n')
      const suffix = atTopLevel
        ? ''
        : $to.parent.textBetween($to.parentOffset, $to.parent.content.size, undefined, '\n')

      const lines = normalized.split('\n')
      const last = lines[lines.length - 1] ?? ''
      // 只有一行时不能套用「首行 + 末行」的模板：lines[0] 与 last 是同一行，
      // 会被插入两次变成两段。它出现在这里是因为选区跨段落或覆盖整个文档。
      const paragraphs =
        lines.length === 1
          ? [schema.node('paragraph', null, inlineNodes(schema, prefix + last + suffix))]
          : [
              schema.node('paragraph', null, inlineNodes(schema, prefix + (lines[0] ?? ''))),
              ...lines
                .slice(1, -1)
                .map((line) => schema.node('paragraph', null, inlineNodes(schema, line))),
              schema.node('paragraph', null, inlineNodes(schema, last + suffix)),
            ]

      const tr = state.tr.replaceWith(start, end, paragraphs)
      // 光标放在最后一行粘贴内容之后、原有后缀之前。
      // 用段落自身的大小累加，不依赖映射的边界语义。
      //
      // 只有一个段落时，前缀也被合进了这一段（选区跨段落或覆盖整个文档），
      // 所以进入该段落后的偏移要把前缀长度算上，否则光标会落在粘贴内容之前。
      const offsetInLastParagraph =
        (lines.length === 1 ? prefix.length : 0) + last.length
      let cursor = tr.mapping.map(start)
      for (const paragraph of paragraphs.slice(0, -1)) cursor += paragraph.nodeSize
      cursor += 1 + offsetInLastParagraph
      tr.setSelection(TextSelection.create(tr.doc, cursor))
      dispatch(tr.scrollIntoView())
      return true
    },
  },
})

const overlayContext = {
  editor,
  doc: props.doc,
  provider: props.provider,
  connected: computed(() => props.connected),
  surface,
}

const { pointers, onPointerMove, onPointerLeave } = usePresence(overlayContext)

const {
  selectedCount,
  rectangles,
  dragRect,
  onPointerDown,
  onPointerMove: onSelectPointerMove,
  onPointerUp,
  onPointerCancel,
  onClickCapture,
  clear: clearSelection,
  selectedText,
  deleteSelected,
} = useParagraphSelection(overlayContext)

/**
 * 复制一段文本并给出统一反馈。
 *
 * 复制正文与复制所选段落共用：字符串为空也要照常复制——只选中空段时，
 * 空字符串就是正确的结果。
 */
async function copyText(value: string): Promise<void> {
  if (await tryCopyText(value)) {
    copyState.value = 'copied'
    copyFallback.value = null
    return
  }
  // 剪贴板不可用时提供可手动选择的文本，而不是假装已经复制。
  copyState.value = 'failed'
  copyFallback.value = value
}

/** 复制所选段落。复制后保留选区，方便接着做别的操作。 */
async function copySelection(): Promise<void> {
  const value = selectedText()
  if (value === null) {
    copyState.value = 'failed'
    copyFallback.value = null
    return
  }
  await copyText(value)
}

/** 删除所选段落。成功才清除选区；失败不误报成功。 */
function deleteSelection(): void {
  if (!deleteSelected()) {
    copyState.value = 'failed'
    copyFallback.value = null
  }
}

/**
 * 段落选区存在时的快捷键。
 *
 * 只在正文或已聚焦的外壳上生效，且不拦截输入框、文本框与其他交互控件；中文组合
 * 输入期间一律放行。撤销/重做转发给同一个编辑器实例，用的仍是既有的协作撤销栈，
 * 不在这里另建一套。
 */
function onKeyDown(event: KeyboardEvent): void {
  if (editor.value?.view.composing === true) return

  const target = event.target as HTMLElement | null
  if (target !== null) {
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (target.isContentEditable && target !== editor.value?.view.dom) return
  }

  const modifier = event.ctrlKey || event.metaKey

  // 焦点停在正文外壳上时（框选结束时就是这种状态），键盘事件不会进入 ProseMirror
  // 的键位表，撤销/重做会静默失效——按 Delete 删掉整段后按 Ctrl+Z 什么都不会发生。
  // 这里把它转发给同一个编辑器实例，用的仍然是既有的协作撤销栈，不另建一套。
  // 焦点已经在正文里时不插手，交给编辑器自己处理。
  const editorDom = editor.value?.view.dom
  if (modifier && editorDom !== undefined && target !== editorDom) {
    const key = event.key.toLowerCase()
    if (key === 'z' || key === 'y') {
      event.preventDefault()
      if (key === 'y' || event.shiftKey) redo()
      else undo()
      return
    }
  }

  if (selectedCount.value === 0) return

  if (modifier && (event.key === 'c' || event.key === 'C')) {
    // 让原生 copy 事件填剪贴板，不在这里抢占。
    return
  }
  if (modifier) return

  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    deleteSelection()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    clearSelection()
  }
}

/** 原生复制：同步填入 text/plain，不全局抢占剪贴板事件。 */
function onCopy(event: ClipboardEvent): void {
  if (selectedCount.value === 0) return
  const value = selectedText()
  if (value === null) return
  event.clipboardData?.setData('text/plain', value)
  event.preventDefault()
  copyState.value = 'copied'
  copyFallback.value = null
}

onBeforeUnmount(() => {
  // 先销毁编辑视图，避免会话关闭后编辑内核仍持有 Y.Doc 订阅。
  editor.value?.destroy()
})

function undo(): void {
  editor.value?.chain().focus().undo().run()
}

function redo(): void {
  editor.value?.chain().focus().redo().run()
}

/**
 * 复制正文。
 *
 * 用编辑器公开的纯文本序列化能力：段落之间是换行，段内 SoftBreak/HardBreak 也是
 * 换行，因此 Shift+Enter 产生的换行不会在复制时丢失。
 */
function plainText(): string {
  return editor.value?.getText({ blockSeparator: '\n' }) ?? ''
}

async function copyBody(): Promise<void> {
  await copyText(plainText())
}
</script>

<template>
  <div class="editor-pane">
    <!--
      选择相关的控件放在**同一行**工具栏里，不另起一行：新增一行会把正文整体向下推，
      拖动过程中参考系跟着漂移，框选范围就算错了（实测拖动矩形被压成十几像素高）。
    -->
    <div class="editor-toolbar">
      <button type="button" class="toolbar-button" @click="undo">撤销</button>
      <button type="button" class="toolbar-button" @click="redo">重做</button>
      <button type="button" class="toolbar-button" @click="copyBody">复制正文</button>
      <template v-if="selectedCount > 0">
        <span class="selection-count" data-selection-count>已选 {{ selectedCount }} 段</span>
        <button type="button" class="toolbar-button" @click="copySelection">
          复制所选段落
        </button>
        <button type="button" class="toolbar-button" @click="deleteSelection">
          删除所选段落
        </button>
        <button type="button" class="toolbar-button" @click="clearSelection">清除选择</button>
      </template>
    </div>

    <p class="editor-hint">从正文左侧留白拖动可以选择整段；正文内拖动仍然是选中文字。</p>

    <p v-if="copyState === 'copied'" class="info-text">已复制正文</p>
    <p v-else-if="copyState === 'failed'" class="error-text">
      无法访问剪贴板，请手动复制下面的内容
    </p>
    <textarea
      v-if="copyFallback !== null"
      class="plain-text-fallback"
      aria-label="可复制的纯文本"
      readonly
      :value="copyFallback"
    ></textarea>

    <div
      ref="surface"
      class="editor-surface"
      tabindex="0"
      :style="{ '--selection-gutter': `${GUTTER_WIDTH}px` }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove($event), onSelectPointerMove($event)"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @pointerleave="onPointerLeave"
      @click.capture="onClickCapture"
      @keydown="onKeyDown"
      @copy="onCopy"
    >
      <EditorContent :editor="editor" />
      <!--
        远端鼠标指针画在正文之外：覆盖层不接收事件、不参与辅助技术朗读。
        正文 DOM 不被改写，装饰也不进入复制结果。
      -->
      <div class="presence-overlay" aria-hidden="true">
        <!--
          段落高亮：本机半透明，远端用该协作者的颜色画轮廓。
          远端不复制发送者的框选矩形，只按同一段落引用显示选中状态。
        -->
        <span
          v-for="(entry, index) in rectangles"
          :key="`${entry.clientId ?? 'local'}:${index}`"
          class="selection-highlight"
          :class="{ 'selection-highlight--local': entry.local }"
          :data-local-paragraph-selection="entry.local ? '' : undefined"
          :data-remote-paragraph-selection="entry.local ? undefined : ''"
          :style="{
            left: `${entry.rect.left}px`,
            top: `${entry.rect.top}px`,
            width: `${entry.rect.width}px`,
            height: `${entry.rect.height}px`,
            borderColor: entry.local ? undefined : entry.color,
          }"
        ></span>

        <span
          v-if="dragRect !== null"
          class="selection-drag"
          data-selection-drag
          :style="{
            left: `${dragRect.left}px`,
            top: `${dragRect.top}px`,
            width: `${dragRect.width}px`,
            height: `${dragRect.height}px`,
          }"
        ></span>

        <span
          v-for="pointer in pointers"
          :key="pointer.clientId"
          class="remote-pointer"
          data-remote-pointer
          :style="{ left: `${pointer.left}px`, top: `${pointer.top}px` }"
        >
          <span class="remote-pointer-dot" :style="{ background: pointer.color }"></span>
          <span class="remote-pointer-name" :style="{ background: pointer.color }">
            {{ pointer.name }}
          </span>
        </span>
      </div>
    </div>
  </div>
</template>
