import { shallowRef, type ShallowRef } from 'vue'
import * as Y from 'yjs'

import { openJournal, type Journal } from '../collab/journal'
import { MAX_PENDING_BYTES } from '../collab/protocol'
import {
  CollabProviderClient,
  type ProviderEvent,
  type ProviderState,
} from '../collab/provider'
import { deriveSaveState, type SaveState } from '../collab/save-state'

export type SessionState = {
  save: SaveState
  connected: boolean
  pending: number
  message: string | null
  /** 待发送内容超过上限时暂停新增编辑，已有记录仍然保留。 */
  paused: boolean
}

export interface DocumentSession {
  doc: Y.Doc
  /** 正文根结构就绪前不挂载编辑器，避免客户端各自补一份默认段落。 */
  canMountEditor: ShallowRef<boolean>
  state: ShallowRef<SessionState>
  /** 最近的连接、txId 与确认事件，仅供折叠调试面板展示。 */
  events: ShallowRef<ProviderEvent[]>
  retry(): void
  close(): Promise<void>
}

export const BODY_FIELD = 'body'

/** 调试面板最多保留的事件条数，避免长时间运行无限累积。 */
export const MAX_DEBUG_EVENTS = 100

function hasBodyRoot(doc: Y.Doc): boolean {
  return doc.getXmlFragment(BODY_FIELD).length > 0
}

function websocketUrl(documentId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}/ws/documents/${encodeURIComponent(documentId)}`
}

const initialProviderState: ProviderState = {
  restored: true,
  connected: false,
  ready: false,
  localWrites: 0,
  unacknowledged: 0,
  localError: false,
  remoteError: false,
  message: null,
  errorCode: null,
}

/**
 * 打开一个文档会话：先恢复本地日志，再启动同步。
 *
 * 恢复不依赖 WebSocket 成功，因此断网时已有内容仍可继续编辑；反过来，
 * 本地没有正文根结构时也不会自行生成一份默认正文——那会让每个客户端都往
 * 共享文档里塞一个段落。
 */
export async function openDocumentSession(
  documentId: string,
): Promise<DocumentSession> {
  const journal: Journal = await openJournal()
  const doc = new Y.Doc()
  await journal.restore(documentId, doc)

  const canMountEditor = shallowRef(hasBodyRoot(doc))
  const events = shallowRef<ProviderEvent[]>([])
  const state = shallowRef<SessionState>({
    save: 'restoring',
    connected: false,
    pending: 0,
    message: null,
    paused: false,
  })

  let providerState: ProviderState = initialProviderState

  const refresh = (): void => {
    state.value = {
      save: deriveSaveState(providerState),
      connected: providerState.connected,
      pending: providerState.unacknowledged,
      message: providerState.message,
      paused: provider.pendingBytes() > MAX_PENDING_BYTES,
    }
  }

  const observeBody = (): void => {
    if (hasBodyRoot(doc)) canMountEditor.value = true
  }

  const provider = new CollabProviderClient({
    documentId,
    doc,
    journal,
    url: websocketUrl(documentId),
    onState: (next) => {
      providerState = next
      observeBody()
      refresh()
    },
    onEvent: (event) => {
      const next = [...events.value, event]
      events.value =
        next.length > MAX_DEBUG_EVENTS ? next.slice(next.length - MAX_DEBUG_EVENTS) : next
    },
  })

  doc.on('update', observeBody)
  refresh()
  await provider.start()

  return {
    doc,
    canMountEditor,
    state,
    events,
    retry(): void {
      provider.retry()
    },
    async close(): Promise<void> {
      // 先取消本地订阅，再关闭会话：视图不得在会话销毁后继续收到更新。
      doc.off('update', observeBody)
      await provider.stop()
      journal.close()
    },
  }
}
