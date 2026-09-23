import * as Y from 'yjs'

/**
 * 文档备份：把完整 Yjs 状态导出成一个文件，在另一个地址导入回同一份文档。
 *
 * 这个文件只做编解码与校验，不碰 Vue、不碰会话、不发网络请求。它存在的理由是同源
 * 隔离无法被应用取消：换了协议、主机名或端口就是另一份浏览器存储，本地未同步的
 * 内容不会跟着过去，只能靠用户显式导出再导入。
 *
 * 导出的是完整 update（`Y.encodeStateAsUpdate`），包含离线的插入**和删除**；
 * 不用纯文本、HTML 或 ProseMirror JSON 代替——那些无法与现有 CRDT 历史合并。
 */

export type DocumentBackupV1 = {
  format: 'dom-collab-backup'
  version: 1
  schema: 'paragraph-text-hardbreak-v1'
  documentId: string
  exportedAt: string
  sourceOrigin: string
  updateBase64: string
}

export type ParsedBackup = {
  metadata: DocumentBackupV1
  update: Uint8Array
  previewText: string
}

/** 文件上限。超过就不产生「本程序自己也读不回来」的文件。 */
export const MAX_BACKUP_FILE_BYTES = 8 * 1024 * 1024
/** 解码后的 update 上限。 */
export const MAX_BACKUP_UPDATE_BYTES = 4 * 1024 * 1024

export const BACKUP_FORMAT = 'dom-collab-backup'
export const BACKUP_VERSION = 1
export const BACKUP_SCHEMA = 'paragraph-text-hardbreak-v1'

const BODY_ROOT = 'body'
const PARAGRAPH = 'paragraph'
const HARD_BREAK = 'hardBreak'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

/** 编码时按块处理，避免对大数组展开成参数列表而爆栈。 */
const BASE64_CHUNK = 0x8000

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK))
  }
  return btoa(binary)
}

function fromBase64(value: string, label: string): Uint8Array {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new Error(`${label} 不是有效的 Base64。`)
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new Error(`${label} 不是有效的 Base64。`)
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

/** 校验并规范化来源地址：只能是 http/https 的裸 origin。 */
function normalizeOrigin(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('备份文件缺少来源地址。')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('备份文件的来源地址无法解析。')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('备份文件的来源地址必须是 http 或 https。')
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('备份文件的来源地址不能带路径、查询参数或片段。')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('备份文件的来源地址不能包含凭据。')
  }
  return url.origin
}

function normalizeDocumentId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('备份文件缺少文档标识。')
  }
  const normalized = raw.trim().toLowerCase()
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error('备份文件的文档标识不是合法的 UUID。')
  }
  return normalized
}

/** 解析文本内容：只允许纯字符串，不接受任何格式标记。 */
function requirePlainText(node: Y.XmlText, where: string): void {
  const delta = node.toDelta()
  for (const op of delta) {
    const insert = (op as { insert?: unknown }).insert
    if (typeof insert !== 'string') {
      throw new Error(`${where} 含有不允许的嵌入内容。`)
    }
    const attributes = (op as { attributes?: Record<string, unknown> }).attributes
    if (attributes && Object.keys(attributes).length > 0) {
      throw new Error(`${where} 含有不允许的格式标记。`)
    }
  }
}

function readParagraphText(paragraph: Y.XmlElement, index: number): string {
  const attributes = paragraph.getAttributes()
  if (Object.keys(attributes).length > 0) {
    throw new Error(`第 ${index + 1} 个段落带有不允许的属性。`)
  }

  let text = ''
  for (const child of paragraph.toArray()) {
    if (child instanceof Y.XmlText) {
      requirePlainText(child, `第 ${index + 1} 个段落`)
      text += child.toString()
      continue
    }
    if (child instanceof Y.XmlElement && child.nodeName === HARD_BREAK) {
      if (Object.keys(child.getAttributes()).length > 0 || child.length > 0) {
        throw new Error(`第 ${index + 1} 个段落里的换行带有不允许的内容。`)
      }
      text += '\n'
      continue
    }
    throw new Error(`第 ${index + 1} 个段落含有不允许的节点。`)
  }
  return text
}

/**
 * 把 update 应用到一个临时文档并检查结构。
 *
 * 临时文档在 finally 里销毁；校验失败时抛出用户可读的错误，调用方的正文不受影响。
 */
function inspectUpdate(update: Uint8Array): string {
  const probe = new Y.Doc()
  try {
    // 先建好 body 根再应用，避免把根名不符的更新当作合法内容。
    const fragment = probe.getXmlFragment(BODY_ROOT)
    Y.applyUpdate(probe, update)

    const roots = Object.keys(probe.toJSON())
    if (roots.length !== 1 || roots[0] !== BODY_ROOT) {
      throw new Error('备份文件包含不属于本文档的共享内容。')
    }

    const paragraphs = fragment.toArray()
    if (paragraphs.length === 0) {
      throw new Error('备份文件里没有任何段落，不是有效的文档内容。')
    }

    const lines = paragraphs.map((node, index) => {
      if (!(node instanceof Y.XmlElement) || node.nodeName !== PARAGRAPH) {
        throw new Error(`备份文件的第 ${index + 1} 个节点不是段落。`)
      }
      return readParagraphText(node, index)
    })
    return lines.join('\n')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('备份文件')) throw error
    if (error instanceof Error && /^第 \d+/.test(error.message)) throw error
    throw new Error('备份文件的内容无法解析为本文档结构。')
  } finally {
    probe.destroy()
  }
}

/** 导出当前文档的完整状态。文档为空时也会导出，由导入侧判断是否可用。 */
export function serializeBackup(
  documentId: string,
  doc: Y.Doc,
  sourceOrigin: string,
): string {
  const normalizedId = normalizeDocumentId(documentId)
  const origin = normalizeOrigin(sourceOrigin)

  const update = Y.encodeStateAsUpdate(doc)
  if (update.byteLength > MAX_BACKUP_UPDATE_BYTES) {
    throw new Error(
      `正文过大（${Math.round(update.byteLength / 1024)} KiB），超过备份上限 ${Math.round(
        MAX_BACKUP_UPDATE_BYTES / 1024 / 1024,
      )} MiB。`,
    )
  }

  const backup: DocumentBackupV1 = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schema: BACKUP_SCHEMA,
    documentId: normalizedId,
    exportedAt: new Date().toISOString(),
    sourceOrigin: origin,
    updateBase64: toBase64(update),
  }
  return JSON.stringify(backup)
}

/**
 * 解析并检查备份文件。
 *
 * 依次检查：文件大小、JSON、格式与版本声明、文档标识、时间、来源地址、
 * Base64 与解码大小，最后把 update 应用到一个临时文档上核对结构。
 * 任何一步失败都抛出用户可读的错误，调用方的文档不受影响。
 */
export function parseBackup(json: string): ParsedBackup {
  if (utf8Length(json) > MAX_BACKUP_FILE_BYTES) {
    throw new Error(
      `备份文件过大，超过上限 ${Math.round(MAX_BACKUP_FILE_BYTES / 1024 / 1024)} MiB。`,
    )
  }

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('备份文件不是有效的 JSON。')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('备份文件的顶层必须是一个对象。')
  }
  const payload = raw as Record<string, unknown>

  if (payload.format !== BACKUP_FORMAT) {
    throw new Error('这不是本程序的备份文件（格式标识不匹配）。')
  }
  if (payload.version !== BACKUP_VERSION) {
    throw new Error(`备份文件版本不受支持：${String(payload.version)}。`)
  }
  if (payload.schema !== BACKUP_SCHEMA) {
    throw new Error(`备份文件的正文结构不受支持：${String(payload.schema)}。`)
  }

  const documentId = normalizeDocumentId(payload.documentId)
  const sourceOrigin = normalizeOrigin(payload.sourceOrigin)

  if (typeof payload.exportedAt !== 'string' || Number.isNaN(Date.parse(payload.exportedAt))) {
    throw new Error('备份文件的导出时间不是有效的时间。')
  }

  if (typeof payload.updateBase64 !== 'string') {
    throw new Error('备份文件缺少正文数据。')
  }
  // 先按 Base64 长度估算解码大小，避免为超限文件分配内存。
  if ((payload.updateBase64.length / 4) * 3 > MAX_BACKUP_UPDATE_BYTES + 8) {
    throw new Error(
      `备份文件的正文过大，超过上限 ${Math.round(MAX_BACKUP_UPDATE_BYTES / 1024 / 1024)} MiB。`,
    )
  }

  const update = fromBase64(payload.updateBase64, '备份文件的正文数据')
  if (update.byteLength > MAX_BACKUP_UPDATE_BYTES) {
    throw new Error(
      `备份文件的正文过大，超过上限 ${Math.round(MAX_BACKUP_UPDATE_BYTES / 1024 / 1024)} MiB。`,
    )
  }

  const previewText = inspectUpdate(update)

  return {
    metadata: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      schema: BACKUP_SCHEMA,
      documentId,
      exportedAt: payload.exportedAt,
      sourceOrigin,
      updateBase64: payload.updateBase64,
    },
    update,
    previewText,
  }
}

/** 备份文件的建议文件名。 */
export function backupFileName(documentId: string, exportedAt: string): string {
  const stamp = exportedAt.replace(/[:.]/g, '-').replace(/Z$/, '')
  return `${normalizeDocumentId(documentId)}-${stamp}.collab-backup.json`
}
