import * as Y from 'yjs'

import { REMOTE_ORIGIN, RESTORE_ORIGIN, type Journal, type PendingTx } from './journal'
import {
  ProtocolViolation,
  decodeServerMessage,
  encodeHello,
  encodeSyncEnd,
  encodeTx,
  type DecodedServerMessage,
} from './protocol'
import type { SaveInputs } from './save-state'

/** WebSocket 的就绪常量；不依赖全局 WebSocket 是否可用。 */
const SOCKET_OPEN = 1

/** 单个上行事务的确认超时。超时后重新握手，本地队列原样保留。 */
export const ACK_TIMEOUT_MS = 5000
export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 10000
export const RECONNECT_JITTER_MS = 250

export type SocketLike = Pick<
  WebSocket,
  'readyState' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onclose' | 'onerror'
>

export type Clock = {
  schedule(callback: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
  random(): number
}

export type ProviderState = SaveInputs & {
  message: string | null
  /** 服务端报告的固定错误码，供界面区分「文档不存在」这类情况。 */
  errorCode: string | null
}

/** 供折叠调试面板展示的技术事件，不参与任何状态判断。 */
export type ProviderEvent = {
  kind: 'connect' | 'open' | 'sync' | 'send' | 'ack' | 'broadcast' | 'close' | 'error'
  detail: string
}

export type ProviderOptions = {
  documentId: string
  doc: Y.Doc
  journal: Journal
  url: string
  onState: (state: ProviderState) => void
  socketFactory?: (url: string) => SocketLike
  clock?: Clock
  onEvent?: (event: ProviderEvent) => void
}

export interface CollabProvider {
  start(): Promise<void>
  retry(): void
  stop(): Promise<void>
}

const realClock: Clock = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
}

/** 一轮握手的阶段。只有 syncing 之后才允许上行发送。 */
type Phase = 'idle' | 'connecting' | 'syncing' | 'catchup' | 'replaying' | 'steady'

/** 本地写入失败时保留的原始内容，重试写入完成前不发送。 */
type RetryWrite = { kind: 'edit' | 'catchup' | 'remote'; update: Uint8Array }

export class CollabProviderClient implements CollabProvider {
  private readonly documentId: string
  private readonly doc: Y.Doc
  private readonly journal: Journal
  private readonly url: string
  private readonly onState: (state: ProviderState) => void
  private readonly socketFactory: (url: string) => SocketLike
  private readonly clock: Clock
  private readonly onEvent: ((event: ProviderEvent) => void) | null

  private socket: SocketLike | null = null
  private syncId: string | null = null
  /** 连接代次。异步步骤恢复执行时用它判断自己是否仍属于当前连接。 */
  private generation = 0
  private phase: Phase = 'idle'
  private stopped = false

  private connected = false
  private ready = false
  private localWrites = 0
  private unacknowledged = 0
  private pendingByteCount = 0
  private localError = false
  private remoteError = false
  private permanent = false
  private message: string | null = null
  private errorCode: string | null = null

  /** 已持久化但尚未发送的事务，按落盘顺序排列。 */
  private outbound: PendingTx[] = []
  /** 本轮握手需要原样重发的历史事务。 */
  private replayQueue: PendingTx[] = []
  /** 正在等待确认的事务；同一时刻最多一个。 */
  private inFlight: PendingTx | null = null
  /** 依据服务端状态向量生成的补同步事务，优先于重放队列发送。 */
  private catchup: PendingTx | null = null

  private barrierId: string | null = null
  private barrierPending: Set<string> | null = null
  private barrierSent = false

  private retryWrites: RetryWrite[] = []
  private retryAcks: string[] = []

  private reconnectHandle: unknown = null
  private ackHandle: unknown = null
  private reconnectAttempt = 0

  private inbound: Promise<void> = Promise.resolve()
  private persistence: Promise<void> = Promise.resolve()

  constructor(options: ProviderOptions) {
    this.documentId = options.documentId
    this.doc = options.doc
    this.journal = options.journal
    this.url = options.url
    this.onState = options.onState
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as SocketLike)
    this.clock = options.clock ?? realClock
    this.onEvent = options.onEvent ?? null
  }

  /** 待发送更新累计字节数，供界面判断是否暂停新增编辑。 */
  pendingBytes(): number {
    return this.pendingByteCount
  }

  async start(): Promise<void> {
    if (this.stopped) return
    this.doc.on('update', this.handleDocUpdate)
    await this.flushRetryWrites()
    this.connect()
  }

  retry(): void {
    if (this.stopped) return
    this.localError = false
    this.remoteError = false
    this.permanent = false
    this.message = null
    this.errorCode = null
    this.reconnectAttempt = 0
    this.publish()
    void this.flushRetryWrites()
    // 连接仍然健康时只补做本地写入，不必要地断开重连会打断正常同步。
    if (this.socket === null || this.socket.readyState !== SOCKET_OPEN) {
      this.connect()
    } else {
      this.pump()
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.doc.off('update', this.handleDocUpdate)
    this.clearReconnect()
    // 让在途的异步步骤失效；它们已经开始写入的本地持久化仍会完成。
    this.generation += 1
    this.teardown()
    // 不能在异步持久化完成前销毁待保存状态。
    await this.persistence
    this.publish()
  }

  // --- 本地编辑 -----------------------------------------------------------

  private readonly handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // 恢复重放与服务端广播都已经各自落盘，不能再次产生发送事务。
    if (origin === RESTORE_ORIGIN || origin === REMOTE_ORIGIN) return
    this.localWrites += 1
    this.publish()
    this.enqueue(() => this.storeLocal(update, 'edit'))
  }

  private enqueue(task: () => Promise<void>): void {
    const run = this.persistence.then(task)
    // 单个任务失败不打断后续写入；失败原因已在任务内部转成可见状态。
    this.persistence = run.then(
      () => undefined,
      () => undefined,
    )
  }

  private async storeLocal(update: Uint8Array, kind: 'edit' | 'catchup'): Promise<void> {
    try {
      const pending = await this.journal.appendLocal(this.documentId, update, kind)
      this.localWrites = Math.max(0, this.localWrites - 1)
      this.trackPending(pending)
      this.outbound.push(pending)
      this.publish()
      this.pump()
    } catch (error) {
      this.localWrites = Math.max(0, this.localWrites - 1)
      this.failLocalWrite({ kind, update }, error)
    }
  }

  private failLocalWrite(write: RetryWrite, error: unknown): void {
    this.localError = true
    this.message = `本地保存失败：${describe(error)}`
    // 原始字节留在内存重试队列里：重试写入的就是同一份内容，
    // 不通过重新插入文本重建操作。
    this.retryWrites.push(write)
    this.publish()
  }

  private async flushRetryWrites(): Promise<void> {
    const writes = this.retryWrites
    const acks = this.retryAcks
    this.retryWrites = []
    this.retryAcks = []

    for (const txId of acks) {
      try {
        await this.journal.acknowledge(this.documentId, txId)
      } catch (error) {
        this.retryAcks.push(txId)
        this.localError = true
        this.message = `本地确认写入失败：${describe(error)}`
        this.publish()
      }
    }

    for (const write of writes) {
      if (write.kind === 'remote') {
        try {
          await this.journal.appendRemote(this.documentId, write.update)
        } catch (error) {
          this.failLocalWrite(write, error)
        }
        continue
      }
      await this.storeLocal(write.update, write.kind)
    }

    if (this.retryWrites.length === 0 && this.retryAcks.length === 0 && !this.remoteError) {
      this.localError = false
      this.message = null
      this.publish()
    }
  }

  // --- 连接生命周期 -------------------------------------------------------

  private connect(): void {
    if (this.stopped) return
    this.clearReconnect()
    this.teardown()

    this.generation += 1
    const generation = this.generation
    this.syncId = crypto.randomUUID()
    this.phase = 'connecting'
    this.emit('connect', `连接 ${this.url}（syncId ${this.syncId.slice(0, 8)}）`)
    this.publish()

    let socket: SocketLike
    try {
      socket = this.socketFactory(this.url)
    } catch (error) {
      this.message = describe(error)
      this.publish()
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    this.attach(socket, generation)
  }

  private attach(socket: SocketLike, generation: number): void {
    socket.onopen = () => {
      if (generation !== this.generation) return
      this.connected = true
      this.ready = false
      this.phase = 'syncing'
      this.emit('open', '连接已建立，发送 hello')
      this.publish()
      this.send(
        encodeHello(this.documentId, this.syncId as string, Y.encodeStateVector(this.doc)),
      )
    }

    socket.onmessage = (event: MessageEvent) => {
      let message: DecodedServerMessage
      try {
        message = decodeServerMessage(event.data)
      } catch (error) {
        this.reportProtocolFailure(error, generation)
        return
      }
      if (generation !== this.generation) return
      if (message.syncId !== this.syncId) return

      // 单条有序入站链：同一连接的帧严格按到达顺序处理。
      this.inbound = this.inbound
        .then(async () => {
          // 异步步骤恢复时再次核对代次，旧连接遗留任务不得改变新连接状态。
          if (generation !== this.generation) return
          await this.handleServerMessage(message, generation)
        })
        .catch((error: unknown) => {
          this.reportProtocolFailure(error, generation)
        })
    }

    socket.onclose = () => {
      if (generation !== this.generation) return
      this.teardown()
      this.publish()
      this.scheduleReconnect()
    }

    socket.onerror = () => {
      if (generation !== this.generation) return
      // 浏览器在 error 之后还会触发 close，这里只记录不重复处理。
      this.message = '连接出错，正在重试'
      this.publish()
    }
  }

  /** 关闭当前连接并复位所有连接范围内的状态。未确认事务仍留在日志里。 */
  private teardown(): void {
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      this.emit('close', '连接已断开')
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      try {
        socket.close()
      } catch {
        // 已经关闭的连接无需处理。
      }
    }
    this.connected = false
    this.ready = false
    this.phase = 'idle'
    // 未确认事务仍在日志中，下一次握手会按原 txId 原内容重放。
    this.inFlight = null
    this.catchup = null
    this.replayQueue = []
    this.barrierPending = null
    this.barrierId = null
    this.barrierSent = false
    this.clearAckTimer()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.permanent || this.reconnectHandle !== null) return
    const attempt = this.reconnectAttempt
    this.reconnectAttempt += 1
    const base = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
    // 带随机抖动，避免多个客户端在同一时刻同时重连。
    const delay = base + Math.floor(this.clock.random() * RECONNECT_JITTER_MS)
    this.reconnectHandle = this.clock.schedule(() => {
      this.reconnectHandle = null
      this.connect()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectHandle !== null) {
      this.clock.cancel(this.reconnectHandle)
      this.reconnectHandle = null
    }
  }

  // --- 入站处理 -----------------------------------------------------------

  private async handleServerMessage(
    message: DecodedServerMessage,
    generation: number,
  ): Promise<void> {
    switch (message.type) {
      case 'sync':
        this.emit('sync', `收到同步差量 seq=${message.seq}`)
        await this.handleSync(message, generation)
        return
      case 'update':
        this.emit('broadcast', `收到广播 seq=${message.seq}`)
        await this.persistRemote(message.update)
        return
      case 'ack':
        this.emit('ack', `确认 txId ${message.txId.slice(0, 8)} seq=${message.seq}`)
        await this.handleAck(message.txId, generation)
        return
      case 'ready':
        // 旧屏障的 ready 不能把新连接标记为已同步。
        if (
          this.barrierSent &&
          this.barrierId !== null &&
          message.barrierId === this.barrierId
        ) {
          this.ready = true
          this.reconnectAttempt = 0
          this.message = null
          this.publish()
          this.pump()
        }
        return
      case 'error':
        this.handleServerError(message.code, message.retryable, message.message)
        return
    }
  }

  private async handleSync(
    message: Extract<DecodedServerMessage, { type: 'sync' }>,
    generation: number,
  ): Promise<void> {
    await this.persistRemote(message.update)
    if (generation !== this.generation) return

    // 等本地写入屏障：补同步差量必须建立在已落盘的内容之上。
    const barrier = this.persistence
    await barrier
    if (generation !== this.generation) return

    const backlog = await this.journal.pending(this.documentId)
    if (generation !== this.generation) return

    // 本轮结束屏障覆盖握手时待确认的事务；它们全部确认后才请求 ready。
    this.barrierId = crypto.randomUUID()
    this.barrierPending = new Set(backlog.map((tx) => tx.txId))
    this.barrierSent = false

    // 删除不改变状态向量，因此不能因为「状态向量相同」跳过补同步；
    // 差量编码本身包含删除信息，空差量也是合法且幂等的。
    const catchupUpdate = Y.encodeStateAsUpdate(this.doc, message.stateVector)
    const catchup = await this.journal.appendLocal(
      this.documentId,
      catchupUpdate,
      'catchup',
    )
    if (generation !== this.generation) return

    this.barrierPending.add(catchup.txId)
    this.trackPending(catchup)
    this.catchup = catchup
    this.phase = 'catchup'

    // 历史事务一律按原 txId 原内容重发；已经排队的那些改由重放队列统一处理，
    // 避免同一条事务被发送两次。
    const replayed = new Set(backlog.map((tx) => tx.txId))
    this.replayQueue = backlog
    this.outbound = this.outbound.filter((tx) => !replayed.has(tx.txId))

    this.publish()
    this.pump()
  }

  private async persistRemote(update: Uint8Array): Promise<void> {
    // 先保留日志写入任务，再应用到文档。
    const write = this.journal.appendRemote(this.documentId, update)
    Y.applyUpdate(this.doc, update, REMOTE_ORIGIN)
    try {
      await write
    } catch (error) {
      this.failLocalWrite({ kind: 'remote', update }, error)
    }
  }

  private async handleAck(txId: string, generation: number): Promise<void> {
    // 先把确认写进本地日志：确认本身也是需要持久化的状态。
    try {
      await this.journal.acknowledge(this.documentId, txId)
    } catch (error) {
      this.retryAcks.push(txId)
      this.localError = true
      this.message = `本地确认写入失败：${describe(error)}`
      this.publish()
      // 不推进发送队列：确认未落盘就不能声称这一批已经处理完。
      return
    }
    if (generation !== this.generation) return

    this.clearAckTimer()
    if (this.inFlight !== null && this.inFlight.txId === txId) {
      const settled = this.inFlight
      this.inFlight = null
      this.unacknowledged = Math.max(0, this.unacknowledged - 1)
      this.pendingByteCount = Math.max(0, this.pendingByteCount - settled.update.byteLength)
      if (settled.kind === 'catchup') this.phase = 'replaying'
    }

    this.barrierPending?.delete(txId)
    this.publish()
    this.pump()
  }

  private handleServerError(code: string, retryable: boolean, detail: string): void {
    this.remoteError = true
    this.errorCode = code
    this.message = `${code}：${detail}`
    this.emit('error', `${code}（${retryable ? '可重试' : '不可重试'}）：${detail}`)
    this.publish()

    if (retryable) {
      // 服务端暂时写不进去：保留本地队列，重新握手后原样重试。
      this.teardown()
      this.scheduleReconnect()
      return
    }
    // 协议或数据错误：停止盲目重试同一无效消息，保留全部本地内容供复制。
    this.permanent = true
    this.clearReconnect()
    this.teardown()
  }

  private reportProtocolFailure(error: unknown, generation: number): void {
    if (generation !== this.generation) return
    this.permanent = true
    this.remoteError = true
    this.message = `协议错误：${describe(error)}`
    this.emit('error', this.message)
    this.clearReconnect()
    this.teardown()
    this.publish()
  }

  // --- 出站处理 -----------------------------------------------------------

  private takeNext(): PendingTx | null {
    if (this.catchup !== null) {
      const tx = this.catchup
      this.catchup = null
      return tx
    }
    if (this.phase === 'catchup') return null
    const replayed = this.replayQueue.shift()
    if (replayed !== undefined) return replayed
    if (this.phase === 'replaying') this.phase = 'steady'
    return this.outbound.shift() ?? null
  }

  private pump(): void {
    if (this.stopped || this.socket === null || this.inFlight !== null) return
    if (this.phase === 'idle' || this.phase === 'connecting' || this.phase === 'syncing') {
      return
    }
    const next = this.takeNext()
    if (next === null) {
      this.maybeAnnounceBarrier()
      return
    }
    this.inFlight = next
    this.emit('send', `发送 ${next.kind} txId ${next.txId.slice(0, 8)}`)
    this.send(
      encodeTx(this.documentId, this.syncId as string, next.txId, next.kind, next.update),
    )
    this.armAckTimer()
  }

  /** 握手时待确认的事务都确认之后，发一次同步结束屏障并等待 ready。 */
  private maybeAnnounceBarrier(): void {
    if (this.barrierSent) return
    if (this.barrierPending === null || this.barrierId === null) return
    if (this.barrierPending.size > 0 || this.inFlight !== null) return
    if (this.outbound.length > 0 || this.replayQueue.length > 0 || this.catchup !== null) {
      return
    }
    this.barrierSent = true
    this.send(encodeSyncEnd(this.documentId, this.syncId as string, this.barrierId))
  }

  private armAckTimer(): void {
    this.clearAckTimer()
    this.ackHandle = this.clock.schedule(() => {
      this.ackHandle = null
      // 确认超时：不丢弃本地队列，重新握手后按原内容重发。
      this.teardown()
      this.scheduleReconnect()
    }, ACK_TIMEOUT_MS)
  }

  private clearAckTimer(): void {
    if (this.ackHandle !== null) {
      this.clock.cancel(this.ackHandle)
      this.ackHandle = null
    }
  }

  private send(text: string): void {
    const socket = this.socket
    if (socket === null || socket.readyState !== SOCKET_OPEN) return
    socket.send(text)
  }

  private emit(kind: ProviderEvent['kind'], detail: string): void {
    this.onEvent?.({ kind, detail })
  }

  // --- 状态 ---------------------------------------------------------------

  private trackPending(pending: PendingTx): void {
    this.unacknowledged += 1
    this.pendingByteCount += pending.update.byteLength
  }

  private publish(): void {
    // provider 只在会话完成本地恢复之后启动，因此 restored 恒为真；
    // 会话在聚合状态时再叠加自己的恢复标志。
    this.onState({
      restored: true,
      connected: this.connected,
      ready: this.ready,
      localWrites: this.localWrites,
      unacknowledged: this.unacknowledged,
      localError: this.localError,
      remoteError: this.remoteError,
      message: this.message,
      errorCode: this.errorCode,
    })
  }
}

function describe(error: unknown): string {
  if (error instanceof ProtocolViolation) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
