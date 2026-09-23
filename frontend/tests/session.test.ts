import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { IndexeddbPersistence, storeState } from 'y-indexeddb'

import {
  CACHE_PREFIX,
  CLOSE_DOCUMENT_NOT_FOUND,
  LOCAL_RESTORE_TIMEOUT_MS,
  LocalRestoreError,
  openDocumentSession,
  type DocumentSession,
} from '../src/documents/session'

/**
 * 会话层只负责组装三个库对象与映射连接状态。这里的测试不碰库的私有字段，
 * 用真实的 y-indexeddb（fake-indexeddb 提供 IndexedDB）与一个可手动驱动的
 * WebSocket 替身，验证生命周期与状态映射。
 */

const control = { hangRestore: false }

vi.mock('y-indexeddb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('y-indexeddb')>()
  class ControllablePersistence extends actual.IndexeddbPersistence {
    constructor(name: string, doc: Y.Doc) {
      super(name, doc)
      if (control.hangRestore) {
        // 模拟缓存打开被永久阻塞：whenSynced 永不完成。
        Object.defineProperty(this, 'whenSynced', { value: new Promise(() => {}) })
      }
    }
  }
  return { ...actual, IndexeddbPersistence: ControllablePersistence }
})

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readonly sent: Uint8Array[] = []

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: Uint8Array): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }

  /** 让连接成功建立。 */
  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  /** 模拟服务端主动关闭并带上关闭码。 */
  serverClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason: '' } as CloseEvent)
  }
}

let sessions: DocumentSession[] = []

async function open(documentId: string): Promise<DocumentSession> {
  const session = await openDocumentSession(documentId)
  sessions.push(session)
  return session
}

/** 往本地缓存里写一段正文，模拟「上次打开时已经存下来」。 */
async function seedCache(documentId: string, text: string): Promise<void> {
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(`${CACHE_PREFIX}${documentId}`, doc)
  await persistence.whenSynced

  const fragment = doc.getXmlFragment('body')
  const paragraph = new Y.XmlElement('paragraph')
  fragment.push([paragraph])
  const node = new Y.XmlText()
  paragraph.push([node])
  node.insert(0, text)

  // destroy 不会等批量写入，用库公开的 storeState 强制刷一次。
  await storeState(persistence, true)
  await persistence.destroy()
  doc.destroy()
}

function bodyText(doc: Y.Doc): string {
  const fragment = doc.getXmlFragment('body')
  return fragment
    .toArray()
    .map((node) =>
      node instanceof Y.XmlElement
        ? node
            .toArray()
            .map((child) => (child instanceof Y.XmlText ? child.toString() : ''))
            .join('')
        : '',
    )
    .join('\n')
}

beforeEach(() => {
  FakeWebSocket.instances = []
  sessions = []
  control.hangRestore = false
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'test.local' } })
})

afterEach(async () => {
  for (const session of sessions) await session.close()
  sessions = []
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('会话生命周期', () => {
  test('先恢复本地缓存再连网络', async () => {
    await seedCache('doc-restore', '缓存里的内容')

    const session = await open('doc-restore')

    // 会话返回时本地内容已经在文档里，并且可以挂载编辑器（离线也能写）。
    expect(bodyText(session.doc)).toBe('缓存里的内容')
    expect(session.canMountEditor.value).toBe(true)
    // 网络连接在恢复之后才发起。
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  test('没有本地正文时不挂载编辑器', async () => {
    const session = await open('doc-empty')

    // 冷启动没有正文：必须等服务器种子，编辑器不能自己补一个空段落。
    expect(session.canMountEditor.value).toBe(false)
    expect(session.doc.getXmlFragment('body').length).toBe(0)
  })

  test('服务器种子到达后允许挂载', async () => {
    const session = await open('doc-seed')
    expect(session.canMountEditor.value).toBe(false)

    // 模拟服务器把种子同步进来。
    const fragment = session.doc.getXmlFragment('body')
    const paragraph = new Y.XmlElement('paragraph')
    session.doc.transact(() => fragment.push([paragraph]))

    await expect.poll(() => session.canMountEditor.value).toBe(true)
  })

  test('缓存有内容但连不上服务器时仍可编辑', async () => {
    await seedCache('doc-offline', '离线也看得到')

    const session = await open('doc-offline')
    // 连接从未成功建立就被断开。
    FakeWebSocket.instances[0]?.serverClose(1006)

    // 网络失败不能清空内存正文，也不影响挂载能力。
    expect(session.canMountEditor.value).toBe(true)
    expect(bodyText(session.doc)).toBe('离线也看得到')
    expect(session.connection.value).not.toBe('connected')
  })

  test('本地恢复超时抛出可重试的错误，并释放半初始化对象', async () => {
    control.hangRestore = true
    vi.useFakeTimers()

    const pending = open('doc-hang')
    const assertion = expect(pending).rejects.toBeInstanceOf(LocalRestoreError)
    await vi.advanceTimersByTimeAsync(LOCAL_RESTORE_TIMEOUT_MS + 1)
    await assertion

    control.hangRestore = false
    vi.useRealTimers()

    // 超时之后重新打开应当成功，说明旧对象没有留下阻塞。
    const session = await open('doc-hang')
    expect(session.canMountEditor.value).toBe(false)
  })

  test('重复关闭是安全的', async () => {
    const session = await open('doc-close')
    await session.close()
    await session.close()
  })

  test('关闭之后不再更新界面状态', async () => {
    const session = await open('doc-after-close')
    const socket = FakeWebSocket.instances[0]
    await session.close()

    const before = session.connection.value
    socket?.open()
    socket?.serverClose(1006)

    expect(session.connection.value).toBe(before)
    expect(session.error.value).toBeNull()
  })
})

describe('连接状态映射', () => {
  test('连接成功后状态为已连接', async () => {
    const session = await open('doc-connect')
    expect(session.connection.value).toBe('connecting')

    FakeWebSocket.instances[0]?.open()
    await expect.poll(() => session.connection.value).toBe('connected')
  })

  test('连接断开后状态为未连接', async () => {
    const session = await open('doc-disconnect')
    FakeWebSocket.instances[0]?.open()
    await expect.poll(() => session.connection.value).toBe('connected')

    FakeWebSocket.instances[0]?.serverClose(1006)
    await expect.poll(() => session.connection.value).toBe('disconnected')
  })

  test('文档不存在时明确报错并停止重连', async () => {
    const session = await open('doc-missing')
    const socket = FakeWebSocket.instances[0]
    socket?.open()

    socket?.serverClose(CLOSE_DOCUMENT_NOT_FOUND)
    await expect.poll(() => session.error.value).toBe('文档不存在')

    // 明确停止：不再创建新的连接尝试。
    const attempts = FakeWebSocket.instances.length
    await new Promise((settle) => setTimeout(settle, 50))
    expect(FakeWebSocket.instances.length).toBe(attempts)
  })

  test('重试会重新发起连接并清除错误', async () => {
    const session = await open('doc-retry')
    expect(session.error.value).toBeNull()

    session.retry()
    expect(session.connection.value).toBe('connecting')
    expect(session.error.value).toBeNull()
  })

  test('重连成功后不再残留连接错误', async () => {
    const session = await open('doc-error-cleared')
    const socket = FakeWebSocket.instances[0]
    socket?.open()
    await expect.poll(() => session.connection.value).toBe('connected')

    // 连接出错：显示错误并退回未连接。
    socket?.onerror?.(new Event('error'))
    await expect.poll(() => session.error.value).toBe('连接出错，正在重试')

    // 重连成功必须清掉这条错误，否则界面会同时显示「已连接」和「连接出错」。
    socket?.open()
    await expect.poll(() => session.connection.value).toBe('connected')
    expect(session.error.value).toBeNull()
  })

  test('已连接时重试不会把状态改回正在连接', async () => {
    const session = await open('doc-retry-while-connected')
    const socket = FakeWebSocket.instances[0]
    socket?.open()
    await expect.poll(() => session.connection.value).toBe('connected')

    session.retry()

    // 已经连上就不该被改写成「正在连接」。
    expect(session.connection.value).toBe('connected')

    // 等一拍，确认状态没有被异步事件带偏。
    await new Promise((settle) => setTimeout(settle, 30))
    expect(session.connection.value).toBe('connected')
  })

  test('文档不存在是终态，不会被后续连接事件覆盖', async () => {
    const session = await open('doc-missing-terminal')
    const socket = FakeWebSocket.instances[0]
    socket?.open()

    socket?.serverClose(CLOSE_DOCUMENT_NOT_FOUND)
    await expect.poll(() => session.error.value).toBe('文档不存在')

    // 后续的连接错误提示不能把「文档不存在」盖掉。
    socket?.onerror?.(new Event('error'))
    await new Promise((settle) => setTimeout(settle, 20))
    expect(session.error.value).toBe('文档不存在')

    // 重试也不该清掉它。
    session.retry()
    expect(session.error.value).toBe('文档不存在')
  })
})
