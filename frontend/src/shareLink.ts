/** 分享地址与当前文档的存储来源分开；生成链接不会导航或迁移本地数据。 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(host)
    || host === '[::1]' || host === '0.0.0.0' || host === '[::]'
}

function isLanIPv4(host: unknown): host is string {
  if (typeof host !== 'string') return false
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false
  const [a, b] = parts.map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function createShareLink(href: string, documentId: string, lanHost?: string): string {
  const url = new URL(href)
  if (isLocalHostname(url.hostname)) {
    // 不把回环地址当作可供另一台设备使用的协作链接。
    if (!isLanIPv4(lanHost)) return ''
    url.hostname = lanHost
  }
  url.hash = `/documents/${encodeURIComponent(documentId)}`
  return url.href
}

export async function readShareHosts(): Promise<string[]> {
  const response = await fetch('/api/share-addresses', {
    cache: 'no-store', signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object' || !('hosts' in payload) || !Array.isArray(payload.hosts)) {
    throw new Error('服务端返回的地址列表无效')
  }
  return [...new Set(payload.hosts.filter(isLanIPv4))]
}
