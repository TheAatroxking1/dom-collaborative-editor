import Collaboration from '@tiptap/extension-collaboration'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import type { Doc } from 'yjs'

/**
 * 首版正文的最小 schema：Document → Paragraph → Text，外加 HardBreak。
 *
 * 不启用 StarterKit 的普通历史扩展：撤销重做由 Collaboration 自带的协作历史
 * 负责，两套历史同时存在会互相冲突。也不启用首版范围之外的 marks、图片或列表。
 */
export function editorExtensions(doc: Doc) {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    Collaboration.configure({ document: doc, field: 'body' }),
  ]
}
