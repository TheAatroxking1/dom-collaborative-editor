import {
  editorText as textOf,
  expect,
  focusEditor,
  openDocumentAt,
  test,
  waitForConnected,
} from './fixtures'

/**
 * 路由切换的竞态。
 *
 * 打开一个文档是异步的：要先校验文档存在，再等本地缓存恢复。如果用户在打开
 * 过程中切到了另一个文档，先开始的那次结果绝不能覆盖当前会话——否则会出现
 * 「地址栏是 B，正文和编辑目标还是 A」的串会话问题。
 */

test.describe('文档切换', () => {
  test('打开过程中切走，旧结果不会覆盖新页面', async ({ backend, first }) => {
    const slowId = await backend.createDocument()
    const targetId = await backend.createDocument()

    // 让第一个文档的校验慢下来，制造「还没打开完就切走」的窗口。
    await first.route(`**/api/documents/${slowId}`, async (route) => {
      await new Promise((settle) => setTimeout(settle, 1500))
      await route.continue()
    })

    await first.goto(`/#/documents/${slowId}`)
    await expect.poll(() => first.url()).toContain(slowId)

    // 第一个文档仍在打开中，立刻切到第二个。
    await first.evaluate((id) => {
      window.location.hash = `#/documents/${id}`
    }, targetId)

    await expect(first.getByRole('textbox', { name: '文档正文' })).toBeVisible()
    await waitForConnected(first)
    expect(first.url()).toContain(targetId)

    // 等第一个文档那次延迟的校验返回；如果它会覆盖当前会话，这里就会串。
    await first.waitForTimeout(2000)
    expect(first.url()).toContain(targetId)
    expect(first.url()).not.toContain(slowId)

    // 后续编辑必须落在第二个文档上。
    await focusEditor(first)
    await first.keyboard.insertText('只属于第二个文档')
    await expect
      .poll(() => backend.readStoredText(targetId), { timeout: 20_000 })
      .toBe('只属于第二个文档')

    // 第一个文档没有被写入任何内容。
    await expect.poll(() => backend.readStoredText(slowId)).toBe('')
  })

  test('切换文档后再切回来，正文仍然正确', async ({ backend, first }) => {
    const firstId = await backend.createDocument()
    const secondId = await backend.createDocument()

    await openDocumentAt(first, firstId)
    await focusEditor(first)
    await first.keyboard.insertText('第一个文档的内容')
    await expect.poll(() => textOf(first)).toBe('第一个文档的内容')

    await openDocumentAt(first, secondId)
    await focusEditor(first)
    await first.keyboard.insertText('第二个文档的内容')
    await expect.poll(() => textOf(first)).toBe('第二个文档的内容')

    // 切回第一个：内容必须来自各自的缓存与房间，不能串。
    await first.evaluate((id) => {
      window.location.hash = `#/documents/${id}`
    }, firstId)
    await expect.poll(() => textOf(first)).toBe('第一个文档的内容')
  })

  test('回到首页后不再显示编辑器', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('离开前的内容')
    await expect.poll(() => textOf(first)).toBe('离开前的内容')

    await first.goto('/')
    await expect(first.getByRole('button', { name: '新建文档' })).toBeVisible()
    await expect(first.getByRole('textbox', { name: '文档正文' })).toHaveCount(0)
  })
})
