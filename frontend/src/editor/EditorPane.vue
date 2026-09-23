<script setup lang="ts">
import { EditorContent, useEditor } from '@tiptap/vue-3'
import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'
import { onBeforeUnmount, ref } from 'vue'
import type * as Y from 'yjs'

import { editorExtensions } from './extensions'

const props = defineProps<{
  doc: Y.Doc
}>()

const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
const copyFallback = ref<string | null>(null)

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
  extensions: editorExtensions(props.doc),
  editorProps: {
    attributes: {
      class: 'editor-body',
      role: 'textbox',
      'aria-label': '文档正文',
      'aria-multiline': 'true',
      spellcheck: 'false',
    },
    /**
     * 粘贴只取 text/plain，并按内容决定是行内插入还是拆段。
     *
     * ProseMirror 默认在剪贴板同时提供 HTML 与纯文本时优先用 HTML；这里显式改用
     * 纯文本，不经过 innerHTML。
     *
     * 关键是不能把任何粘贴都当成「完整段落」：在 ab|cd 处粘贴 X 必须是 abXcd，
     * 而不是 ab / X / cd 三段。只有真正带换行的内容才拆段，且首行接前缀、
     * 末行接后缀。
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

      if (!normalized.includes('\n')) {
        // 单行粘贴：作为行内文本插入，与选区替换语义一致。
        dispatch(state.tr.insertText(normalized, from, to).scrollIntoView())
        return true
      }

      const lines = normalized.split('\n')
      const prefix = $from.parent.textBetween(0, $from.parentOffset, undefined, '\n')
      const suffix = $to.parent.textBetween($to.parentOffset, $to.parent.content.size, undefined, '\n')
      const last = lines[lines.length - 1] ?? ''

      const paragraphs = [
        schema.node('paragraph', null, inlineNodes(schema, prefix + (lines[0] ?? ''))),
        ...lines
          .slice(1, -1)
          .map((line) => schema.node('paragraph', null, inlineNodes(schema, line))),
        schema.node('paragraph', null, inlineNodes(schema, last + suffix)),
      ]

      // 替换整个段落范围（含被重建的前后缀），这样同一段内与跨段的选区都能正确处理。
      const start = $from.before($from.depth)
      const end = $to.after($to.depth)
      dispatch(state.tr.replaceWith(start, end, paragraphs).scrollIntoView())
      return true
    },
  },
})

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
  const value = plainText()
  try {
    await navigator.clipboard.writeText(value)
    copyState.value = 'copied'
    copyFallback.value = null
  } catch {
    // 剪贴板不可用时提供可手动选择的文本，而不是假装已经复制。
    copyState.value = 'failed'
    copyFallback.value = value
  }
}
</script>

<template>
  <div class="editor-pane">
    <div class="editor-toolbar">
      <button type="button" class="toolbar-button" @click="undo">撤销</button>
      <button type="button" class="toolbar-button" @click="redo">重做</button>
      <button type="button" class="toolbar-button" @click="copyBody">复制正文</button>
    </div>

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

    <EditorContent :editor="editor" class="editor-surface" />
  </div>
</template>
