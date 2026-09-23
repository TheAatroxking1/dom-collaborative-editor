/**
 * 剪贴板复制的能力检测。
 *
 * 局域网 HTTP 不是安全上下文，Clipboard API 会缺失或被拒绝；这时不该让复制按钮
 * 静默失败，而应让调用方显示可手动选中的文本。因此这里只回答「自动复制成功了
 * 没有」，不抛异常、不自行降级。
 */
export async function tryCopyText(text: string): Promise<boolean> {
  if (typeof window === 'undefined' || !window.isSecureContext) return false
  const clipboard = navigator.clipboard
  if (!clipboard || typeof clipboard.writeText !== 'function') return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
