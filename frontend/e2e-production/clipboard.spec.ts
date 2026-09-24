import {
  editorText,
  expect,
  focusEditor,
  PRODUCTION_ORIGIN,
  test,
  waitForConnected,
} from './fixtures'

/**
 * 复制功能的降级验收。
 *
 * 局域网 HTTP 不是安全上下文，Clipboard API 会缺失或被拒绝。这一组用例模拟那几种
 * 能力分支，确认文档页能看到可手动复制的完整链接，而不是静默失败。
 *
 * 注意：本文件验证的是能力分支的界面行为。真实局域网设备上的复制仍需人工验证，
 * 不能由这里的 mock 结果替代（见 docs/offline-lan-validation.md）。
 */

const SHARE_LINK_INPUT = '可手动复制的协作链接'
const LAN_HOST = '192.168.50.10'
const LAN_ORIGIN = PRODUCTION_ORIGIN.replace('127.0.0.1', LAN_HOST)

// 使用确定的网卡地址，复制行为不依赖运行测试的电脑装了几张虚拟网卡。
test.beforeEach(async ({ page }) => {
  await page.route('**/api/share-addresses', (route) => route.fulfill({ json: { hosts: [LAN_HOST] } }))
})

/** 让页面看起来像 HTTP 局域网：安全上下文为 false。 */
async function simulateInsecureContext(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
  })
}

/** 模拟浏览器没有 Clipboard API。 */
async function simulateMissingClipboard(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  })
}

/** 模拟用户拒绝剪贴板权限。 */
async function simulateDeniedClipboard(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new DOMException('拒绝', 'NotAllowedError')),
        readText: () => Promise.reject(new DOMException('拒绝', 'NotAllowedError')),
      },
    })
  })
}

async function openDocument(
  page: import('@playwright/test').Page,
  server: { createDocument: () => Promise<string> },
): Promise<string> {
  const documentId = await server.createDocument()
  await page.goto(`${PRODUCTION_ORIGIN}/#/documents/${documentId}`)
  await expect(page.getByRole('textbox', { name: '文档正文' })).toBeVisible()
  await waitForConnected(page)
  return documentId
}

test.describe('协作链接复制', () => {
  test('安全上下文下自动复制成功', async ({ server, page }) => {
    const documentId = await openDocument(page, server)

    await page.getByRole('button', { name: '复制协作链接' }).click()
    await expect(page.getByText('协作链接已复制')).toBeVisible()

    // 成功时不显示手动复制字段。
    await expect(page.getByRole('textbox', { name: SHARE_LINK_INPUT })).toHaveCount(0)

    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe(`${LAN_ORIGIN}/#/documents/${documentId}`)
    expect(page.url()).toBe(`${PRODUCTION_ORIGIN}/#/documents/${documentId}`)
  })

  test('HTTP 局域网（非安全上下文）显示可手动复制的链接', async ({ server, page }) => {
    await simulateInsecureContext(page)
    const documentId = await openDocument(page, server)

    await page.getByRole('button', { name: '复制协作链接' }).click()

    // 必须在文档页看到失败提示与完整链接——之前这条反馈只写进了首页变量。
    await expect(page.getByText('请选中下方链接手动复制')).toBeVisible()
    const field = page.getByRole('textbox', { name: SHARE_LINK_INPUT })
    await expect(field).toBeVisible()
    await expect(field).toHaveValue(`${LAN_ORIGIN}/#/documents/${documentId}`)
    // 只读但可以选中复制。
    await expect(field).toHaveAttribute('readonly', '')

    await field.click()
    await field.press('ControlOrMeta+A')
    const selected = await page.evaluate(() => String(window.getSelection()?.toString()))
    expect(selected).toContain(documentId)
  })

  test('浏览器缺少 Clipboard API 时同样降级', async ({ server, page }) => {
    await simulateMissingClipboard(page)
    await openDocument(page, server)

    await page.getByRole('button', { name: '复制协作链接' }).click()
    await expect(page.getByText('请选中下方链接手动复制')).toBeVisible()
    await expect(page.getByRole('textbox', { name: SHARE_LINK_INPUT })).toBeVisible()
  })

  test('权限被拒绝时同样降级', async ({ server, page }) => {
    await simulateDeniedClipboard(page)
    await openDocument(page, server)

    await page.getByRole('button', { name: '复制协作链接' }).click()
    await expect(page.getByText('请选中下方链接手动复制')).toBeVisible()
    await expect(page.getByRole('textbox', { name: SHARE_LINK_INPUT })).toBeVisible()
  })

  test('切换文档后复制反馈会重置', async ({ browser, server }) => {
    const context = await browser.newContext({ serviceWorkers: 'allow' })
    const page = await context.newPage()
    try {
      await simulateInsecureContext(page)
      await page.route('**/api/share-addresses', (route) => route.fulfill({ json: { hosts: [LAN_HOST] } }))
      const firstId = await openDocument(page, server)
      await page.getByRole('button', { name: '复制协作链接' }).click()
      await expect(page.getByRole('textbox', { name: SHARE_LINK_INPUT })).toHaveValue(
        `${LAN_ORIGIN}/#/documents/${firstId}`,
      )

      const secondId = await server.createDocument()
      await page.evaluate((id: string) => {
        window.location.hash = `#/documents/${id}`
      }, secondId)
      await expect(page.getByRole('textbox', { name: '文档正文' })).toBeVisible()

      // 旧反馈不能挂在新文档上。
      await expect(page.getByRole('textbox', { name: SHARE_LINK_INPUT })).toHaveCount(0)
      await expect(page.getByText('请选中下方链接手动复制')).toHaveCount(0)

      // 再次复制给出的是新文档的链接。
      await page.getByRole('button', { name: '复制协作链接' }).click()
      await expect(page.getByRole('textbox', { name: SHARE_LINK_INPUT })).toHaveValue(
        `${LAN_ORIGIN}/#/documents/${secondId}`,
      )
    } finally {
      await context.close()
    }
  })

  test('多个网卡地址时选择后才复制，不擅自选择虚拟网卡', async ({ server, page }) => {
    await page.route('**/api/share-addresses', (route) => route.fulfill({ json: { hosts: ['10.0.0.8', LAN_HOST] } }))
    const id = await openDocument(page, server)
    const copy = page.getByRole('button', { name: '复制协作链接' })
    await expect(copy).toBeDisabled()
    await page.getByRole('combobox', { name: '协作链接地址' }).selectOption(LAN_HOST)
    await copy.click()
    await expect(page.getByText('协作链接已复制')).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${LAN_ORIGIN}/#/documents/${id}`)
  })

  test('没有局域网地址时提示原因，不复制无效的本机链接', async ({ server, page }) => {
    await page.route('**/api/share-addresses', (route) => route.fulfill({ json: { hosts: [] } }))
    await openDocument(page, server)
    await expect(page.getByRole('button', { name: '复制协作链接' })).toBeDisabled()
    await expect(page.getByText(/未检测到局域网 IPv4 地址/)).toBeVisible()
    await expect(page.getByText('协作链接已复制')).toHaveCount(0)
  })

  test('地址接口失败后可以重试，正文仍可编辑', async ({ server, page }) => {
    let attempts = 0
    await page.route('**/api/share-addresses', (route) => route.fulfill(
      attempts++ === 0 ? { status: 503, body: 'unavailable' } : { json: { hosts: [LAN_HOST] } },
    ))
    const id = await openDocument(page, server)
    await expect(page.getByText(/无法获取局域网地址/)).toBeVisible()
    await expect(page.getByRole('button', { name: '复制协作链接' })).toBeDisabled()
    await focusEditor(page)
    await page.keyboard.insertText('地址检测失败也能编辑')
    await expect.poll(() => editorText(page)).toBe('地址检测失败也能编辑')
    await page.getByRole('button', { name: '重新检测地址' }).click()
    await page.getByRole('button', { name: '复制协作链接' }).click()
    await expect(page.getByText('协作链接已复制')).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${LAN_ORIGIN}/#/documents/${id}`)
  })
})

test.describe('正文复制', () => {
  test('安全上下文下自动复制正文', async ({ server, page }) => {
    await openDocument(page, server)
    await focusEditor(page)
    await page.keyboard.insertText('第一行')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.insertText('第二行')
    await expect.poll(() => editorText(page)).toBe('第一行\n第二行')

    await page.getByRole('button', { name: '复制正文' }).click()
    await expect(page.getByText('已复制正文')).toBeVisible()

    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(
      /\r\n/g,
      '\n',
    )
    expect(copied).toBe('第一行\n第二行')
  })

  test('无法自动复制时给出可手动选择的正文', async ({ server, page }) => {
    await simulateInsecureContext(page)
    await openDocument(page, server)
    await focusEditor(page)
    await page.keyboard.insertText('需要手动复制的中文内容')
    await expect.poll(() => editorText(page)).toBe('需要手动复制的中文内容')

    await page.getByRole('button', { name: '复制正文' }).click()

    await expect(page.getByText(/无法访问剪贴板/)).toBeVisible()
    const fallback = page.getByRole('textbox', { name: '可复制的纯文本' })
    await expect(fallback).toHaveValue('需要手动复制的中文内容')
    await expect(fallback).toHaveAttribute('readonly', '')
  })
})
