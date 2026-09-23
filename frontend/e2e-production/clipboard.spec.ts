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
    expect(copied).toBe(`${PRODUCTION_ORIGIN}/#/documents/${documentId}`)
  })

  test('HTTP 局域网（非安全上下文）显示可手动复制的链接', async ({ server, page }) => {
    await simulateInsecureContext(page)
    const documentId = await openDocument(page, server)

    await page.getByRole('button', { name: '复制协作链接' }).click()

    // 必须在文档页看到失败提示与完整链接——之前这条反馈只写进了首页变量。
    await expect(page.getByText('请选中下方链接手动复制')).toBeVisible()
    const field = page.getByRole('textbox', { name: SHARE_LINK_INPUT })
    await expect(field).toBeVisible()
    await expect(field).toHaveValue(`${PRODUCTION_ORIGIN}/#/documents/${documentId}`)
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
      const firstId = await openDocument(page, server)
      await page.getByRole('button', { name: '复制协作链接' }).click()
      await expect(page.getByRole('textbox', { name: SHARE_LINK_INPUT })).toHaveValue(
        `${PRODUCTION_ORIGIN}/#/documents/${firstId}`,
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
        `${PRODUCTION_ORIGIN}/#/documents/${secondId}`,
      )
    } finally {
      await context.close()
    }
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
