import { shallowRef, type ShallowRef } from 'vue'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebsocketProvider } from 'y-websocket'

/**
 * 一个文档会话就是三个库对象的组装与生命周期管理：Y.Doc、本地缓存 provider、
 * 网络 provider。这里不实现协议、不维护发送队列、不判断「已保存」。
 *
 * 关于保存承诺的边界：``connected`` 与库的 ``sync`` 事件都不代表某次输入已经写入
 * 磁盘。库不提供逐更新的落盘回执，因此界面也不会显示「服务端已保存」。
 */

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

type ConnectionStatus = 'connected' | 'connecting' | 'disconnected'

export interface DocumentSession {
  doc: Y.Doc
  /**
   * 本会话的网络 Provider。
   *
   * 协作者光标、鼠标与段落选区都复用它的 Awareness——临时状态只此一份，
   * 不另外创建 Provider 或 Awareness，也不绕过「先恢复缓存再连接」的顺序。
   */
  readonly provider: WebsocketProvider
  /** 正文根结构就绪前不挂载编辑器，避免客户端各自补一份默认段落。 */
  canMountEditor: ShallowRef<boolean>
  connection: ShallowRef<ConnectionState>
  error: ShallowRef<string | null>
  retry(): void
  close(): Promise<void>
}

/** 浏览器缓存的命名空间。旧的自研日志使用另一个名字，两者不互相干扰。 */
export const CACHE_PREFIX = 'dom-collab-v2:'

/** 等待本地恢复的上限。超过就报错让用户重试，不能无限停在 loading。 */
export const LOCAL_RESTORE_TIMEOUT_MS = 10_000
/** 清理缓存 provider 的上限：它可能等待尚未完成的数据库打开。 */
export const TEARDOWN_TIMEOUT_MS = 10_000

/** 服务端在文档不存在时使用的关闭码。 */
export const CLOSE_DOCUMENT_NOT_FOUND = 4404

/** 文档不存在是终态：不会被后续的连接事件覆盖。 */
export const DOCUMENT_MISSING = '文档不存在'

export const BODY_FIELD = 'body'

/** 本地缓存恢复失败（含超时）。调用方应丢弃这个会话并重新打开。 */
export class LocalRestoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalRestoreError'
  }
}

export function hasBodyRoot(doc: Y.Doc): boolean {
  return doc.getXmlFragment(BODY_FIELD).length > 0
}

function websocketBaseUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}/ws/documents`
}

async function withTimeout(task: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_done, fail) => {
    timer = setTimeout(() => fail(new Error('timeout')), timeoutMs)
  })
  try {
    await Promise.race([task, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function waitForLocalRestore(local: IndexeddbPersistence): Promise<void> {
  return new Promise((done, fail) => {
    const timer = setTimeout(
      () => fail(new LocalRestoreError('本地内容恢复超时')),
      LOCAL_RESTORE_TIMEOUT_MS,
    )
    local.whenSynced.then(
      () => {
        clearTimeout(timer)
        done()
      },
      (error: unknown) => {
        clearTimeout(timer)
        fail(new LocalRestoreError(String(error)))
      },
    )
  })
}

/**
 * 打开一个文档会话。
 *
 * 顺序是硬性的：先等本地缓存恢复，再连网络。本地已有正文时即便服务器不可达也能
 * 继续编辑；本地没有正文时保持等待，由服务器的唯一种子提供内容——编辑器不会
 * 自己补一个空段落，否则每个客户端都会往共享文档里塞一次初始化。
 */
export async function openDocumentSession(documentId: string): Promise<DocumentSession> {
  const doc = new Y.Doc()
  const local = new IndexeddbPersistence(`${CACHE_PREFIX}${documentId}`, doc)

  let network: WebsocketProvider | null = null

  try {
    await waitForLocalRestore(local)
  } catch (error) {
    // 半初始化的对象不复用：释放掉，让调用方重新开一个会话。
    await withTimeout(local.destroy(), TEARDOWN_TIMEOUT_MS).catch(() => undefined)
    doc.destroy()
    throw error
  }

  const canMountEditor = shallowRef(hasBodyRoot(doc))
  const connection = shallowRef<ConnectionState>('connecting')
  const error = shallowRef<string | null>(null)

  const observeBody = (): void => {
    if (hasBodyRoot(doc)) canMountEditor.value = true
  }
  doc.on('update', observeBody)

  network = new WebsocketProvider(websocketBaseUrl(), documentId, doc, {
    // 先不连：本地缓存已经恢复，再开放网络同步。
    connect: false,
    // 关闭跨标签页广播：同源两个标签页也必须经过 Python 服务端。
    disableBc: true,
    // 显式决定是否重连，不依赖某个版本的默认策略。
    shouldReconnect: (event: CloseEvent) => event.code !== CLOSE_DOCUMENT_NOT_FOUND,
  })

  const onStatus = (event: { status: ConnectionStatus }): void => {
    connection.value =
      event.status === 'connected'
        ? 'connected'
        : event.status === 'connecting'
          ? 'connecting'
          : 'disconnected'
    // 连接成功必须清掉上一次的连接错误：否则重连成功后会同时显示
    // 「已连接」和「连接出错，正在重试」。文档不存在属于终态，保留它。
    if (connection.value === 'connected' && error.value !== DOCUMENT_MISSING) {
      error.value = null
    }
  }
  const onClosed = (event: { code: number; reason: string }): void => {
    if (event.code === CLOSE_DOCUMENT_NOT_FOUND) {
      error.value = DOCUMENT_MISSING
      connection.value = 'disconnected'
    }
  }
  const onConnectionError = (): void => {
    // 文档不存在是终态，不要被后续的重试文案覆盖。
    if (error.value === DOCUMENT_MISSING) return
    error.value = '连接出错，正在重试'
  }

  network.on('status', onStatus)
  network.on('closed', onClosed)
  network.on('connection-error', onConnectionError)

  let closed = false

  const session: DocumentSession = {
    doc,
    provider: network,
    canMountEditor,
    connection,
    error,
    retry(): void {
      if (closed) return
      // 已经连上就不要改写连接状态：重试不该把「已连接」变成「正在连接」。
      if (connection.value === 'connected') return
      if (error.value !== DOCUMENT_MISSING) error.value = null
      connection.value = 'connecting'
      network?.connect()
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true

      // 先撤销订阅，再销毁资源：关闭之后不得再更新界面状态。
      doc.off('update', observeBody)
      network?.off('status', onStatus)
      network?.off('closed', onClosed)
      network?.off('connection-error', onConnectionError)

      // 关掉本地 Awareness 再销毁 Provider：否则这个客户端的光标、鼠标和段落选区
      // 会作为遗留状态继续留在其他人那一侧，直到旧条目超时。
      network?.awareness.setLocalState(null)
      network?.destroy()
      network = null

      // 缓存 provider 的 destroy 可能等待尚未完成的数据库打开；
      // 给上限，不让旧会话的清理无限阻塞路由切换。
      try {
        await withTimeout(local.destroy(), TEARDOWN_TIMEOUT_MS)
      } catch {
        // 超时说明缓存清理仍在后台；数据库连接由浏览器回收。
      }
      doc.destroy()
    },
  }

  // 本地恢复完成之后才开放网络同步。
  network.connect()

  return session
}
