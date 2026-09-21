<script setup lang="ts">
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { onBeforeUnmount, watch } from 'vue'
import type * as Y from 'yjs'

import { editorExtensions } from './extensions'

const props = defineProps<{
  doc: Y.Doc
  /** 待发送内容超限时暂停新增编辑，已有内容与状态都不受影响。 */
  paused: boolean
}>()

/**
 * 编辑器只在正文根结构就绪后挂载：挂载过早会让 y-tiptap 依据空文档补一份
 * 默认段落，等于每个客户端都往共享文档里塞一次初始化内容。
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
  },
})

watch(
  () => props.paused,
  (paused) => {
    editor.value?.setEditable(!paused)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  // 先销毁视图，避免会话关闭后编辑内核仍持有 Y.Doc 订阅。
  editor.value?.destroy()
})

function undo(): void {
  editor.value?.chain().focus().undo().run()
}

function redo(): void {
  editor.value?.chain().focus().redo().run()
}

defineExpose({ undo, redo })
</script>

<template>
  <div class="editor-pane">
    <div class="editor-toolbar">
      <button type="button" class="toolbar-button" @click="undo">撤销</button>
      <button type="button" class="toolbar-button" @click="redo">重做</button>
    </div>
    <EditorContent :editor="editor" class="editor-surface" />
  </div>
</template>
