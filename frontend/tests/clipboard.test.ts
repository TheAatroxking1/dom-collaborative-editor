import { afterEach, describe, expect, test, vi } from 'vitest'

import { tryCopyText } from '../src/clipboard'

/**
 * 剪贴板能力检测。
 *
 * 返回 false 不是错误，而是「这次没能自动复制，请显示可手动复制的字段」——
 * 局域网 HTTP 与权限被拒绝都会走到这里。
 */

type FakeWindow = { isSecureContext: boolean }

function stubEnvironment(options: {
  secure?: boolean
  clipboard?: unknown
}): void {
  const secure = options.secure ?? true
  vi.stubGlobal('window', { isSecureContext: secure } satisfies FakeWindow)
  if ('clipboard' in options) {
    vi.stubGlobal('navigator', { clipboard: options.clipboard })
  } else {
    vi.stubGlobal('navigator', {})
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('tryCopyText', () => {
  test('安全上下文且可用时复制成功', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubEnvironment({ clipboard: { writeText } })

    await expect(tryCopyText('要复制的内容')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('要复制的内容')
  })

  test('非安全上下文直接返回 false，不调用 API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    // 局域网 HTTP 就是这种情况：Clipboard API 存在但不可用。
    stubEnvironment({ secure: false, clipboard: { writeText } })

    await expect(tryCopyText('内容')).resolves.toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })

  test('浏览器没有 Clipboard API 时返回 false', async () => {
    stubEnvironment({ clipboard: undefined })
    await expect(tryCopyText('内容')).resolves.toBe(false)
  })

  test('writeText 不存在时返回 false', async () => {
    stubEnvironment({ clipboard: {} })
    await expect(tryCopyText('内容')).resolves.toBe(false)
  })

  test('权限被拒绝时返回 false 而不是抛出', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('拒绝', 'NotAllowedError'))
    stubEnvironment({ clipboard: { writeText } })

    await expect(tryCopyText('内容')).resolves.toBe(false)
    expect(writeText).toHaveBeenCalled()
  })

  test('其他复制错误也返回 false', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('意外错误'))
    stubEnvironment({ clipboard: { writeText } })

    await expect(tryCopyText('内容')).resolves.toBe(false)
  })

  test('空字符串也会尝试复制并如实返回结果', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubEnvironment({ clipboard: { writeText } })

    await expect(tryCopyText('')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('')
  })
})
