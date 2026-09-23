<script setup lang="ts">
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { onBeforeUnmount, ref } from 'vue'
import type * as Y from 'yjs'

import { editorExtensions } from './extensions'

const props = defineProps<{
  doc: Y.Doc
}>()

const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
const copyFallback = ref<string | null>(null)

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
     * 粘贴只取 text/plain。
     *
     * ProseMirror 默认在剪贴板同时提供 HTML 与纯文本时优先用 HTML；这里显式改用
     * 纯文本，按换行拆成段落，不经过 innerHTML。
     */
    handlePaste: (view, event) => {
      const clipboard = (event as ClipboardEvent).clipboardData
      if (!clipboard) return false
      const text = clipboard.getData('text/plain')
      if (text.length === 0) return false

      const { state, dispatch } = view
      const { from, to, $from } = state.selection
      const paragraphs = text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) =>
          line.length === 0
            ? state.schema.node('paragraph')
            : state.schema.node('paragraph', null, [state.schema.text(line)]),
        )

      // 光标停在空段落里时替换整个段落：否则会把内容插进空段落内部，
      // 留下一个多余的空行。
      const onEmptyParagraph =
        from === to && $from.parent.isTextblock && $from.parent.content.size === 0
      const start = onEmptyParagraph ? $from.before($from.depth) : from
      const end = onEmptyParagraph ? $from.after($from.depth) : to

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
