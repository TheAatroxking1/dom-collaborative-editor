/**
 * 前端协议编解码与运行时校验。
 *
 * 服务端消息在进入任何业务逻辑之前必须经过这里：格式、协议版本与大小都在
 * 这一层拒绝，因此 provider 内部不会遇到半可信的对象。
 */

export const PROTOCOL_VERSION = 1

/** 单个 CRDT 更新的上限。 */
export const MAX_UPDATE_BYTES = 1024 * 1024
/** 单个文本帧的上限。 */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024
/** 待发送更新累计字节的上限，超过后暂停新增编辑并保留已有记录。 */
export const MAX_PENDING_BYTES = 8 * 1024 * 1024
/** 服务端单连接发送队列的帧数上限。 */
export const MAX_OUTGOING_FRAMES = 256

export type Envelope = {
  v: typeof PROTOCOL_VERSION
  documentId: string
  syncId: string
}

export type ClientMessage = Envelope &
  (
    | { type: 'hello'; stateVector: string }
    | { type: 'tx'; txId: string; kind: 'edit' | 'catchup'; update: string }
    | { type: 'sync-end'; barrierId: string }
  )

/** 线上形状：二进制字段是 Base64 字符串。 */
export type ServerMessage = Envelope &
  (
    | { type: 'sync'; update: string; stateVector: string; seq: number }
    | { type: 'update'; update: string; seq: number }
    | { type: 'ack'; txId: string; seq: number }
    | { type: 'ready'; barrierId: string; seq: number }
    | { type: 'error'; code: string; retryable: boolean; message: string }
  )

/** 校验并解码后的形状：二进制字段已是字节，可直接使用。 */
export type DecodedServerMessage = Envelope &
  (
    | { type: 'sync'; update: Uint8Array; stateVector: Uint8Array; seq: number }
    | { type: 'update'; update: Uint8Array; seq: number }
    | { type: 'ack'; txId: string; seq: number }
    | { type: 'ready'; barrierId: string; seq: number }
    | { type: 'error'; code: string; retryable: boolean; message: string }
  )

export class ProtocolViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolViolation'
  }
}

export function encodeHello(
  documentId: string,
  syncId: string,
  stateVector: Uint8Array,
): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'hello',
    documentId,
    syncId,
    stateVector: toBase64(stateVector),
  } satisfies ClientMessage)
}

export function encodeTx(
  documentId: string,
  syncId: string,
  txId: string,
  kind: 'edit' | 'catchup',
  update: Uint8Array,
): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'tx',
    documentId,
    syncId,
    txId,
    kind,
    update: toBase64(update),
  } satisfies ClientMessage)
}

export function encodeSyncEnd(
  documentId: string,
  syncId: string,
  barrierId: string,
): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'sync-end',
    documentId,
    syncId,
    barrierId,
  } satisfies ClientMessage)
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  // 分块拼接，避免一次展开超长参数列表。
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export function fromBase64(value: string): Uint8Array {
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new ProtocolViolation('字段不是有效的 Base64')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value !== 'string') throw new ProtocolViolation(`${key} 必须是字符串`)
  return value
}

function requireSeq(source: Record<string, unknown>): number {
  const value = source.seq
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ProtocolViolation('seq 必须是非负整数')
  }
  return value
}

function requireUpdate(source: Record<string, unknown>, key: string): Uint8Array {
  const bytes = fromBase64(requireString(source, key))
  if (bytes.byteLength > MAX_UPDATE_BYTES) {
    throw new ProtocolViolation(`${key} 超过更新大小上限`)
  }
  return bytes
}

function requireType(source: Record<string, unknown>): string {
  const value = source.type
  if (typeof value !== 'string') throw new ProtocolViolation('缺少消息类型')
  return value
}

/**
 * 把收到的原始帧校验并解码为可直接使用的消息。
 *
 * 所有失败都抛 ProtocolViolation：调用方据此报错并关闭本连接，
 * 而不是把半解析的对象继续往下传。
 */
export function decodeServerMessage(data: unknown): DecodedServerMessage {
  if (typeof data !== 'string') throw new ProtocolViolation('只接受文本帧')
  if (data.length > MAX_FRAME_BYTES) throw new ProtocolViolation('帧超过大小上限')

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    throw new ProtocolViolation('帧不是有效 JSON')
  }
  if (!isRecord(parsed)) throw new ProtocolViolation('帧顶层必须是对象')

  if (parsed.v !== PROTOCOL_VERSION) {
    throw new ProtocolViolation(`不支持的协议版本 ${String(parsed.v)}`)
  }
  const documentId = requireString(parsed, 'documentId')
  const syncId = requireString(parsed, 'syncId')
  const type = requireType(parsed)
  const envelope = { v: PROTOCOL_VERSION, documentId, syncId } as const

  switch (type) {
    case 'sync':
      return {
        ...envelope,
        type,
        update: requireUpdate(parsed, 'update'),
        stateVector: requireUpdate(parsed, 'stateVector'),
        seq: requireSeq(parsed),
      }
    case 'update':
      return {
        ...envelope,
        type,
        update: requireUpdate(parsed, 'update'),
        seq: requireSeq(parsed),
      }
    case 'ack':
      return { ...envelope, type, txId: requireString(parsed, 'txId'), seq: requireSeq(parsed) }
    case 'ready':
      return {
        ...envelope,
        type,
        barrierId: requireString(parsed, 'barrierId'),
        seq: requireSeq(parsed),
      }
    case 'error': {
      const retryable = parsed.retryable
      if (typeof retryable !== 'boolean') {
        throw new ProtocolViolation('error.retryable 必须是布尔值')
      }
      return {
        ...envelope,
        type,
        code: requireString(parsed, 'code'),
        retryable,
        message: requireString(parsed, 'message'),
      }
    }
    default:
      throw new ProtocolViolation(`未知消息类型 ${type}`)
  }
}
