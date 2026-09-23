/** 文档元数据接口。正文内容不经过 HTTP，只走 WebSocket 的 CRDT 通道。 */

export type DocumentMeta = {
  documentId: string
  createdAt: string
}

/** URL 指定的文档不存在。界面必须显示不存在，而不是静默创建空文档。 */
export class DocumentMissingError extends Error {
  constructor(documentId: string) {
    super(`文档不存在：${documentId}`)
    this.name = 'DocumentMissingError'
  }
}

/** 服务端暂时不可用，可以重试。 */
export class ApiUnavailableError extends Error {
  constructor(detail: string) {
    super(`无法连接服务端：${detail}`)
    this.name = 'ApiUnavailableError'
  }
}

async function readMeta(response: Response, documentId: string): Promise<DocumentMeta> {
  if (response.status === 404) throw new DocumentMissingError(documentId)
  if (!response.ok) throw new ApiUnavailableError(`HTTP ${response.status}`)
  const payload = (await response.json()) as DocumentMeta
  if (typeof payload.documentId !== 'string') {
    throw new ApiUnavailableError('返回内容缺少 documentId')
  }
  return payload
}

export async function createDocument(): Promise<DocumentMeta> {
  let response: Response
  try {
    response = await fetch('/api/documents', { method: 'POST' })
  } catch (error) {
    throw new ApiUnavailableError(String(error))
  }
  return readMeta(response, '')
}

export async function readDocument(
  documentId: string,
  signal?: AbortSignal,
): Promise<DocumentMeta> {
  let response: Response
  try {
    response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, { signal })
  } catch (error) {
    // 调用方主动中止与网络失败要区分开，否则超时会被当成「文档不存在」。
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiUnavailableError('请求已超时')
    }
    throw new ApiUnavailableError(String(error))
  }
  return readMeta(response, documentId)
}
