import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { afterEach, describe, expect, test } from 'vitest'

import {
  openJournal,
  type Journal,
} from '../src/collab/journal'
import {
  ACK_TIMEOUT_MS,
  CollabProviderClient,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  type Clock,
  type ProviderState,
  type SocketLike,
} from '../src/collab/provider'
import {
  PROTOCOL_VERSION,
  fromBase64,
  toBase64,
  type ClientMessage,
  type ServerMessage,
} from '../src/collab/protocol'
import { deriveSaveState } from '../src/collab/save-state'

// --- 可控时钟 ---------------------------------------------------------------

/** 手动推进的时钟：退避与超时都不依赖真实时间。 */
class ManualClock implements Clock {
  private tasks = new Map<number, { callback: () => void; at: number }>()
  private nextId = 1
  private now = 0

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId
    this.nextId += 1
    this.tasks.set(id, { callback, at: this.now + delayMs })
    return id
  }

  cancel(handle: unknown): void {
    this.tasks.delete(handle as number)
  }

  random(): number {
    return 0
  }

  /** 已排定的任务数，用于断言旧定时器不残留。 */
  get pending(): number {
    return this.tasks.size
  }

  async advance(delayMs: number): Promise<void> {
    const target = this.now + delayMs
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at)
      const next = due[0]
      if (next === undefined) break
      this.tasks.delete(next[0])
      this.now = next[1].at
      next[1].callback()
      await settle()
    }
    this.now = target
    await settle()
  }
}

// --- FakeSocket 与假服务端 --------------------------------------------------

class FakeSocket implements SocketLike {
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  readonly raw: string[] = []
  readonly messages: ClientMessage[] = []
  syncId: string | null = null
  closed = false
  onSend: ((message: ClientMessage) => void) | null = null

  send(data: string): void {
    this.raw.push(data)
    const message = JSON.parse(data) as ClientMessage
    this.messages.push(message)
    if (message.type === 'hello') this.syncId = message.syncId
    this.onSend?.(message)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({} as Event)
  }

  /** 模拟连接被对端或网络中断。 */
  drop(): void {
    this.readyState = 3
    this.onclose?.({} as CloseEvent)
  }

  deliver(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }

  deliverRaw(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  of(type: ClientMessage['type']): ClientMessage[] {
    return this.messages.filter((message) => message.type === type)
  }
}

/** 只记录、按需回应的假服务端，行为与真实后端的关键语义一致。 */
class FakeServer {
  readonly doc = new Y.Doc()
  seq = 0
  autoAck = true
  autoSync = true
  autoReady = true
  readonly seen = new Set<string>()
  readonly received: ClientMessage[] = []

  handle(socket: FakeSocket, message: ClientMessage): void {
    this.received.push(message)
    const documentId = message.documentId
    const syncId = message.syncId

    switch (message.type) {
      case 'hello':
        if (!this.autoSync) return
        socket.deliver({
          v: PROTOCOL_VERSION,
          type: 'sync',
          documentId,
          syncId,
          update: toBase64(Y.encodeStateAsUpdate(this.doc)),
          stateVector: toBase64(Y.encodeStateVector(this.doc)),
          seq: this.seq,
        })
        return
      case 'tx': {
        if (!this.seen.has(message.txId)) {
          this.seen.add(message.txId)
          this.seq += 1
          Y.applyUpdate(this.doc, fromBase64(message.update))
        }
        if (this.autoAck) this.ack(socket, message.txId)
        return
      }
      case 'sync-end':
        if (this.autoReady) {
          socket.deliver({
            v: PROTOCOL_VERSION,
            type: 'ready',
            documentId,
            syncId,
            barrierId: message.barrierId,
            seq: this.seq,
          })
        }
        return
    }
  }

  ack(socket: FakeSocket, txId: string): void {
    socket.deliver({
      v: PROTOCOL_VERSION,
      type: 'ack',
      documentId: 'document-under-test',
      syncId: socket.syncId as string,
      txId,
      seq: this.seq,
    })
  }

  text(): string {
    return this.doc.getText('probe').toString()
  }
}

// --- 夹具 -------------------------------------------------------------------

/** 让 IndexedDB 回调与 promise 链跑完。 */
async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 400; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`等待超时：${label}`)
}

type Harness = {
  provider: CollabProviderClient
  sockets: FakeSocket[]
  clock: ManualClock
  states: ProviderState[]
  doc: Y.Doc
  journal: Journal
  server: FakeServer
  latest(): ProviderState
  connect(): Promise<FakeSocket>
}

const journals: Journal[] = []

async function createHarness(journalOverride?: Journal): Promise<Harness> {
  const journal = journalOverride ?? (await openJournal(crypto.randomUUID()))
  journals.push(journal)
  const sockets: FakeSocket[] = []
  const clock = new ManualClock()
  const states: ProviderState[] = []
  const doc = new Y.Doc()
  const server = new FakeServer()
  const documentId = 'document-under-test'

  const provider = new CollabProviderClient({
    documentId,
    doc,
    journal,
    url: 'ws://test/ws/documents/' + documentId,
    onState: (state) => states.push(state),
    socketFactory: () => {
      const socket = new FakeSocket()
      socket.onSend = (message) => server.handle(socket, message)
      sockets.push(socket)
      return socket
    },
    clock,
  })

  return {
    provider,
    sockets,
    clock,
    states,
    doc,
    journal,
    server,
    latest: () => states[states.length - 1] as ProviderState,
    async connect() {
      const socket = sockets[sockets.length - 1] as FakeSocket
      socket.open()
      await settle()
      return socket
    },
  }
}

async function startConnected(harness: Harness): Promise<FakeSocket> {
  await harness.provider.start()
  const socket = await harness.connect()
  await waitFor(() => harness.latest()?.ready === true, '握手完成')
  return socket
}

/** 记录本地编辑产生的原始更新字节，用于与发送内容逐字节比对。 */
function captureUpdates(doc: Y.Doc): Uint8Array[] {
  const captured: Uint8Array[] = []
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === null || origin === undefined) captured.push(update)
  })
  return captured
}

function write(doc: Y.Doc, text: string): void {
  doc.getText('probe').insert(doc.getText('probe').length, text)
}

type TxMessage = Extract<ClientMessage, { type: 'tx' }>

function txs(socket: FakeSocket, kind?: 'edit' | 'catchup'): TxMessage[] {
  return socket
    .of('tx')
    .filter((message): message is TxMessage => message.type === 'tx')
    .filter((message) => kind === undefined || message.kind === kind)
}

/** 握手本身会发出补同步事务；断言本地编辑时必须以 kind 过滤。 */
function edits(socket: FakeSocket): TxMessage[] {
  return txs(socket, 'edit')
}

const running: CollabProviderClient[] = []

afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop()
  while (journals.length > 0) journals.pop()?.close()
})

async function track(harness: Harness): Promise<Harness> {
  running.push(harness.provider)
  return harness
}

// --- 发送顺序 ---------------------------------------------------------------

describe('发送顺序与本地持久化', () => {
  test('本地存储未完成前不发送任何上行帧', async () => {
    const harness = await track(await createHarness())
    await startConnected(harness)
    const socket = harness.sockets[0] as FakeSocket
    const before = edits(socket).length

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = harness.journal.appendLocal.bind(harness.journal)
    harness.journal.appendLocal = async (documentId, update, kind) => {
      await gate
      return original(documentId, update, kind)
    }

    write(harness.doc, '本地')
    await settle()
    expect(edits(socket)).toHaveLength(before)

    release()
    await waitFor(() => edits(socket).length > before, '发送本地事务')
  })

  test('发送的内容与本地落盘字节完全一致', async () => {
    const harness = await track(await createHarness())
    await startConnected(harness)
    const socket = harness.sockets[0] as FakeSocket
    const captured = captureUpdates(harness.doc)

    write(harness.doc, '字节一致')
    await waitFor(() => edits(socket).length > 0, '发送本地事务')

    const tx = edits(socket)[0]
    if (tx === undefined) throw new Error('缺少编辑事务')
    const sent = fromBase64(tx.update)
    expect(Array.from(sent)).toEqual(Array.from(captured[0] as Uint8Array))
    expect(tx.kind).toBe('edit')
  })

  test('恢复重放与服务端广播都不会产生上行编辑事务', async () => {
    const journal = await openJournal(crypto.randomUUID())
    journals.push(journal)
    const remote = new Y.Doc()
    remote.getText('probe').insert(0, '既有内容')
    await journal.appendRemote('document-under-test', Y.encodeStateAsUpdate(remote))

    const harness = await track(await createHarness(journal))
    const seedUpdate = Y.encodeStateAsUpdate(remote)
    Y.applyUpdate(harness.doc, seedUpdate)
    await journal.restore('document-under-test', harness.doc)

    await startConnected(harness)
    const socket = harness.sockets[0] as FakeSocket
    await settle()
    // 恢复重放会产生补同步差量，但不会凭空重新执行用户输入。
    expect(edits(socket)).toHaveLength(0)
  })
})

// --- 握手 -------------------------------------------------------------------

describe('握手与补同步', () => {
  test('hello 之后依次发出补同步、历史事务与结束屏障', async () => {
    const harness = await track(await createHarness())
    await harness.provider.start()
    const socket = harness.sockets[0] as FakeSocket
    await harness.connect()
    await waitFor(() => harness.latest()?.ready === true, '握手完成')

    const types = socket.messages.map((message) => message.type)
    expect(types[0]).toBe('hello')
    expect(types).toContain('tx')
    expect(types).toContain('sync-end')
  })

  test('握手会补齐客户端缺失的服务端内容', async () => {
    const harness = await track(await createHarness())
    write(harness.server.doc, '服务端已有')
    await startConnected(harness)

    expect(harness.doc.getText('probe').toString()).toBe('服务端已有')
    const restored = new Y.Doc()
    await harness.journal.restore('document-under-test', restored)
    expect(restored.getText('probe').toString()).toBe('服务端已有')
  })

  test('仅删除的补同步不会被状态向量相等跳过', async () => {
    const harness = await track(await createHarness())
    await startConnected(harness)
    const socket = harness.sockets[0] as FakeSocket

    // 双方先拥有同一份内容。
    write(harness.doc, '0123456789')
    await waitFor(() => harness.server.text() === '0123456789', '内容同步到服务端')

    const before = Y.encodeStateVector(harness.doc)
    harness.doc.getText('probe').delete(5, 2)
    // 仅删除不推进状态向量。
    expect(Y.encodeStateVector(harness.doc)).toEqual(before)
    expect(harness.doc.getText('probe').toString()).toBe('01234789')

    // 重连后服务端必须收到删除。
    socket.drop()
    await harness.clock.advance(RECONNECT_BASE_MS + 1)
    const reconnected = await harness.connect()
    await waitFor(() => harness.server.text() === '01234789', '服务端收到删除')

    // 重连时必须发出补同步差量，仅删除的内容才不会被状态向量相等掩盖。
    expect(txs(reconnected, 'catchup').length).toBeGreaterThan(0)
  })

  test('结束屏障只覆盖握手时的事务，之后的编辑仍保持待保存', async () => {
    const harness = await track(await createHarness())
    await harness.provider.start()

    // 暂时不回 sync，让握手停留在等待阶段。
    harness.server.autoSync = false
    const socket = await harness.connect()

    write(harness.doc, '握手前')
    await waitFor(() => harness.latest().unacknowledged === 1, '握手前的编辑已落盘')

    // 补上握手响应，此时补同步与结束屏障都以这条编辑为前提。
    harness.server.autoSync = true
    harness.server.handle(socket, {
      v: PROTOCOL_VERSION,
      type: 'hello',
      documentId: 'document-under-test',
      syncId: socket.syncId as string,
      stateVector: toBase64(new Uint8Array([0])),
    })
    await waitFor(() => socket.of('sync-end').length === 1, '发出结束屏障')

    // 屏障发出之后的编辑不属于本轮同步。
    harness.server.autoAck = false
    write(harness.doc, '屏障之后')
    await waitFor(() => harness.latest().unacknowledged === 1, '屏障后的编辑进入待确认')

    const syncEnd = socket.of('sync-end')[0]
    if (syncEnd?.type !== 'sync-end') throw new Error('缺少 sync-end')
    harness.server.handle(socket, syncEnd)
    await waitFor(() => harness.latest().ready === true, '收到 ready')

    // ready 只说明本轮握手完成，不能让新的未确认编辑显示成已保存。
    expect(harness.latest().unacknowledged).toBe(1)
    expect(deriveSaveState(harness.latest())).toBe('local-only')
  })
})

// --- 确认与重连 -------------------------------------------------------------

describe('确认与重连', () => {
  test('确认超时后重新握手，并按原 txId 与原内容重发', async () => {
    const harness = await track(await createHarness())
    const first = await startConnected(harness)

    harness.server.autoAck = false
    const captured = captureUpdates(harness.doc)
    write(harness.doc, '超时重发')
    await waitFor(() => edits(first).length > 0, '首次发送')

    const original = edits(first)[0]
    if (original === undefined) throw new Error('缺少编辑事务')

    await harness.clock.advance(ACK_TIMEOUT_MS + 1)
    await harness.clock.advance(RECONNECT_BASE_MS * 2 + 1)

    harness.server.autoAck = true
    const second = await harness.connect()
    await waitFor(
      () => edits(second).some((message) => message.txId === original.txId),
      '原样重发',
    )

    const resent = edits(second).find((message) => message.txId === original.txId)
    if (resent === undefined) throw new Error('缺少重发事务')
    expect(resent.update).toBe(original.update)
    expect(Array.from(fromBase64(resent.update))).toEqual(
      Array.from(captured[0] as Uint8Array),
    )
  })

  test('重复确认是幂等的，不会重复计数', async () => {
    const harness = await track(await createHarness())
    const socket = await startConnected(harness)

    write(harness.doc, '重复确认')
    await waitFor(() => edits(socket).length > 0, '发送编辑事务')
    await waitFor(() => harness.latest()?.unacknowledged === 0, '确认完成')

    const tx = edits(socket)[0]
    if (tx === undefined) throw new Error('缺少编辑事务')
    harness.server.ack(socket, tx.txId)
    harness.server.ack(socket, tx.txId)
    await settle()

    expect(harness.latest().unacknowledged).toBe(0)
    expect(harness.latest().connected).toBe(true)
  })

  test('旧连接的帧与旧定时器不影响新连接', async () => {
    const harness = await track(await createHarness())
    const first = await startConnected(harness)
    const firstSyncId = first.syncId as string

    first.drop()
    await harness.clock.advance(RECONNECT_BASE_MS + 1)
    const second = await harness.connect()
    expect(second.syncId).not.toBe(firstSyncId)

    const before = harness.states.length
    // 旧连接已经解绑，投递任何东西都不应改变状态。
    first.deliverRaw(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'error',
        documentId: 'document-under-test',
        syncId: firstSyncId,
        code: 'BAD_MESSAGE',
        retryable: false,
        message: '旧连接',
      }),
    )
    await settle()
    expect(harness.states.length).toBe(before)

    // 新连接仍按自己的 syncId 正常工作。
    await waitFor(() => harness.latest().ready === true, '新连接握手完成')
    expect(harness.latest().remoteError).toBe(false)
  })

  test('服务端明确拒绝时停止自动重连并保留本地内容', async () => {
    const harness = await track(await createHarness())
    const socket = await startConnected(harness)

    write(harness.doc, '不能丢')
    await waitFor(() => harness.latest().unacknowledged === 0, '首次确认完成')

    socket.deliver({
      v: PROTOCOL_VERSION,
      type: 'error',
      documentId: 'document-under-test',
      syncId: socket.syncId as string,
      code: 'TX_PAYLOAD_MISMATCH',
      retryable: false,
      message: '不一致',
    })
    await settle()

    expect(harness.latest().remoteError).toBe(true)
    expect(harness.latest().message).toContain('TX_PAYLOAD_MISMATCH')

    const created = harness.sockets.length
    await harness.clock.advance(RECONNECT_MAX_MS * 4)
    expect(harness.sockets.length).toBe(created)

    // 本地内容仍然完整。
    const restored = new Y.Doc()
    await harness.journal.restore('document-under-test', restored)
    expect(restored.getText('probe').toString()).toBe('不能丢')
  })

  test('可重试的服务端错误会重新握手并最终确认', async () => {
    const harness = await track(await createHarness())
    const socket = await startConnected(harness)
    harness.server.autoAck = false

    write(harness.doc, '稍后重试')
    await waitFor(() => edits(socket).length === 1, '首次发送')
    const tx = edits(socket)[0]
    if (tx === undefined) throw new Error('缺少编辑事务')
    expect(tx.txId).toBeTruthy()

    socket.deliver({
      v: PROTOCOL_VERSION,
      type: 'error',
      documentId: 'document-under-test',
      syncId: socket.syncId as string,
      code: 'STORAGE_UNAVAILABLE',
      retryable: true,
      message: '写不进去',
    })
    await settle()
    expect(harness.latest().remoteError).toBe(true)
    expect(harness.latest().unacknowledged).toBe(1)

    harness.server.autoAck = true
    await harness.clock.advance(RECONNECT_BASE_MS + 1)
    const second = await harness.connect()
    await waitFor(
      () => edits(second).some((message) => message.txId === tx.txId),
      '重发',
    )
    await waitFor(() => harness.latest().unacknowledged === 0, '最终确认')
    expect(harness.server.text()).toBe('稍后重试')
  })

  test('重连不会重复安装文档监听器', async () => {
    const harness = await track(await createHarness())
    const first = await startConnected(harness)
    first.drop()
    await harness.clock.advance(RECONNECT_BASE_MS + 1)
    const socket = await harness.connect()
    await waitFor(() => harness.latest().ready === true, '重连后握手完成')
    await waitFor(() => harness.latest().unacknowledged === 0, '握手事务确认完成')

    // 直接统计写入次数：确认之后 pending() 会过滤掉已确认记录，不能用来计数。
    let appends = 0
    const original = harness.journal.appendLocal.bind(harness.journal)
    harness.journal.appendLocal = async (documentId, update, kind) => {
      appends += 1
      return original(documentId, update, kind)
    }

    const txBefore = edits(socket).length
    write(harness.doc, '只发一次')
    await waitFor(() => edits(socket).length > txBefore, '发送新编辑')
    await waitFor(() => harness.latest().unacknowledged === 0, '新编辑确认完成')

    // 一次编辑只应写入并发送一次；监听器重复安装会在这里变成两次。
    expect(appends).toBe(1)
  })

  test('停止后不再重连，并且已捕获的本地写入会完成', async () => {
    const harness = await track(await createHarness())
    const socket = await startConnected(harness)

    write(harness.doc, '停止前')
    await harness.provider.stop()

    const created = harness.sockets.length
    await harness.clock.advance(RECONNECT_MAX_MS * 4)
    expect(harness.sockets.length).toBe(created)
    expect(socket.closed).toBe(true)

    const restored = new Y.Doc()
    await harness.journal.restore('document-under-test', restored)
    expect(restored.getText('probe').toString()).toBe('停止前')
  })
})

// --- 本地存储失败 -----------------------------------------------------------

describe('本地存储失败', () => {
  test('写入失败时保留原始字节且不发送，恢复后补写并发送', async () => {
    const harness = await track(await createHarness())
    const socket = await startConnected(harness)

    let failing = true
    const original = harness.journal.appendLocal.bind(harness.journal)
    harness.journal.appendLocal = async (documentId, update, kind) => {
      if (failing) throw new Error('磁盘已满')
      return original(documentId, update, kind)
    }

    const captured = captureUpdates(harness.doc)
    write(harness.doc, '失败后重试')
    await waitFor(() => harness.latest()?.localError === true, '报告本地保存失败')
    expect(edits(socket)).toHaveLength(0)

    failing = false
    harness.provider.retry()
    await waitFor(() => edits(socket).length > 0, '补写后发送')

    const sent = edits(socket)[0]
    if (sent === undefined) throw new Error('缺少编辑事务')
    // 重试写入并发送的就是失败时保留的同一份字节。
    expect(Array.from(fromBase64(sent.update))).toEqual(
      Array.from(captured[0] as Uint8Array),
    )
    expect(harness.latest().localError).toBe(false)
  })

  test('本地保存失败时不会声称已保存', async () => {
    const harness = await track(await createHarness())
    await startConnected(harness)

    harness.journal.appendLocal = async () => {
      throw new Error('写入被拒绝')
    }
    write(harness.doc, '未落盘')
    await waitFor(() => harness.latest()?.localError === true, '报告本地保存失败')
    expect(harness.latest().ready).toBe(true)
    expect(harness.latest().localError).toBe(true)
  })
})

// --- 协议校验 ---------------------------------------------------------------

describe('协议校验', () => {
  test('无法解析的帧会停止会话并报告原因', async () => {
    const harness = await track(await createHarness())
    const socket = await startConnected(harness)

    socket.deliverRaw('{not json')
    await settle()

    expect(harness.latest().remoteError).toBe(true)
    expect(harness.latest().message).toContain('协议错误')
  })

  test('版本不符的帧会被拒绝', async () => {
    const harness = await track(await createHarness())
    const socket = await startConnected(harness)

    socket.deliverRaw(
      JSON.stringify({
        v: 99,
        type: 'update',
        documentId: 'document-under-test',
        syncId: socket.syncId,
        update: '',
        seq: 1,
      }),
    )
    await settle()
    expect(harness.latest().remoteError).toBe(true)
  })

  test('syncId 不匹配的帧被忽略', async () => {
    const harness = await track(await createHarness())
    const socket = await startConnected(harness)

    const target = new Y.Doc()
    target.getText('probe').insert(0, '不该出现')
    socket.deliver({
      v: PROTOCOL_VERSION,
      type: 'update',
      documentId: 'document-under-test',
      syncId: crypto.randomUUID(),
      update: toBase64(Y.encodeStateAsUpdate(target)),
      seq: 1,
    })
    await settle()
    expect(harness.doc.getText('probe').toString()).toBe('')
    expect(harness.latest().remoteError).toBe(false)
  })
})

// --- 待发送字节 -------------------------------------------------------------

describe('待发送字节统计', () => {
  test('待发送字节随确认回落', async () => {
    const harness = await track(await createHarness())
    const socket = await startConnected(harness)
    harness.server.autoAck = false

    write(harness.doc, '统计')
    await waitFor(() => edits(socket).length > 0, '发送')
    const peak = harness.provider.pendingBytes()
    expect(peak).toBeGreaterThan(0)

    harness.server.autoAck = true
    const tx = edits(socket)[0]
    if (tx === undefined) throw new Error('缺少编辑事务')
    harness.server.ack(socket, tx.txId)
    await waitFor(() => harness.provider.pendingBytes() === 0, '确认后回落')
  })
})
