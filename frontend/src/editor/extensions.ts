import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import type { WebsocketProvider } from 'y-websocket'
import type { Doc } from 'yjs'

import { guestUser } from './presence'

/**
 * 首版正文的最小 schema：Document → Paragraph → Text，外加 HardBreak。
 *
 * 不启用 StarterKit 的普通历史扩展：撤销重做由 Collaboration 自带的协作历史
 * 负责，两套历史同时存在会互相冲突。也不启用首版范围之外的 marks、图片或列表。
 *
 * 协作光标使用传进来的**同一个** Provider：Awareness 只有一份，不额外创建连接，
 * 也不改变「先恢复本地缓存再连网络」的既有顺序。
 */
export function editorExtensions(doc: Doc, provider: WebsocketProvider) {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    Collaboration.configure({ document: doc, field: 'body' }),
    CollaborationCaret.configure({
      provider,
      user: guestUser(doc.clientID),
    }),
  ]
}
