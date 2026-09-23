import {
  editorText,
  expect,
  focusEditor,
  openDocumentAt,
  selectLeadingCharacters,
  test,
} from './fixtures'

/**
 * 协作者文字光标与文字选区。
 *
 * 两个独立浏览器上下文经真实 Python 服务同步：远端要能看到对方正在输入的位置和
 * 选中的几个字，同时这些只是临时状态——正文内容与本地读取的正文都不应被它影响。
 */

test.describe('协作者文字光标', () => {
  test('远端光标可见，且不改变正文', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)

    expect(await second.locator('.collaboration-carets__caret').count()).toBe(0)

    await focusEditor(first)
    await first.keyboard.insertText('协作测试')
    await expect.poll(() => editorText(second)).toBe('协作测试')

    // 第二端应看到第一端的光标。
    await expect(second.locator('.collaboration-carets__caret')).toHaveCount(1)
  })

  test('远端文字选区可见，选中内容与本地一致', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('协作测试')
    await openDocumentAt(second, documentId)
    await expect.poll(() => editorText(second)).toBe('协作测试')

    await selectLeadingCharacters(first, 2)

    // 第二端看到高亮的选区，且内容正是被选中的那两个字。
    await expect(second.locator('.ProseMirror-yjs-selection')).toContainText('协作')
    // 选区是临时状态，不能影响正文读取。
    await expect.poll(() => editorText(second)).toBe('协作测试')
  })

  test('光标标签不进入正文文本', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)

    await focusEditor(first)
    await first.keyboard.insertText('正文内容')
    await expect.poll(() => editorText(second)).toBe('正文内容')

    // 第一端看到的正文同样不能带上访客名。
    expect(await editorText(first)).toBe('正文内容')
  })

  test('本地“复制正文”不包含访客名', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    // 两端都打开之后再输入：光标扩展在失焦时会清掉光标，
    // 先输入再打开第二端会让第一端失焦，测到的就不是复制行为而是这个清理行为。
    await openDocumentAt(second, documentId)

    await focusEditor(first)
    await first.keyboard.insertText('只有正文')
    await expect.poll(() => editorText(second)).toBe('只有正文')

    // 第二端此时能看到第一端的光标，但复制出来不能有装饰内容。
    await expect(second.locator('.collaboration-carets__caret')).toHaveCount(1)
    await second.getByRole('button', { name: '复制正文' }).click()
    await expect(second.getByText('已复制正文')).toBeVisible()

    const copied = await second.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe('只有正文')
  })

  test('切换文档后不残留上一份文档的光标', async ({ first, second, openDocument }) => {
    const firstId = await openDocument(first)
    await openDocumentAt(second, firstId)

    await focusEditor(first)
    await first.keyboard.insertText('第一份')
    await expect(second.locator('.collaboration-carets__caret')).toHaveCount(1)

    // 第一端切到另一份文档并在那里保持活跃光标：第二端停在原文档上，
    // 不应再看到它的光标。
    const secondId = await openDocument(first)
    expect(secondId).not.toBe(firstId)
    await focusEditor(first)
    await first.keyboard.insertText('第二份')

    await expect(second.locator('.collaboration-carets__caret')).toHaveCount(0, {
      timeout: 20_000,
    })
  })
})
