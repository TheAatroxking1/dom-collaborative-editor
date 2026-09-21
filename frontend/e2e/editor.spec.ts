import {
  editorParagraphCount as countParagraphs,
  editorText as textOf,
  expect,
  focusEditor,
  test,
} from './fixtures'

test.describe('单人编辑', () => {
  test('新建文档后地址栏带上文档标识，编辑器可输入', async ({ first }) => {
    await first.goto('/')
    await first.getByRole('button', { name: '新建文档' }).click()
    await expect(first).toHaveURL(/#\/documents\/[0-9a-f-]{36}$/)
    await expect(first.getByRole('textbox', { name: '文档正文' })).toBeVisible()

    await focusEditor(first)
    await first.keyboard.type('中文English🙂')
    await expect.poll(() => textOf(first)).toBe('中文English🙂')
  })

  test('刷新页面后正文仍在', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.type('刷新前写入的内容')
    await expect.poll(() => textOf(first)).toBe('刷新前写入的内容')

    await first.reload()
    await expect(first.getByRole('textbox', { name: '文档正文' })).toBeVisible()
    await expect.poll(() => textOf(first)).toBe('刷新前写入的内容')
  })

  test('退格与 Delete 分别删除光标前后的字符', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.type('abcdef')
    await first.keyboard.press('Backspace')
    await expect.poll(() => textOf(first)).toBe('abcde')

    await first.keyboard.press('Home')
    await expect.poll(() => countParagraphs(first)).toBe(1)
    await first.keyboard.press('Delete')
    await expect.poll(() => textOf(first)).toBe('bcde')
  })

  test('回车拆出第二段，退格在段首把两段合并回去', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.type('第一段')
    await first.keyboard.press('Enter')
    await first.keyboard.type('第二段')
    await expect.poll(() => countParagraphs(first)).toBe(2)
    await expect.poll(() => textOf(first)).toBe('第一段\n第二段')

    // 打字后光标在第二段末尾，先回到段首，退格才会把两段合并。
    await first.keyboard.press('Home')
    await first.keyboard.press('Backspace')
    await expect.poll(() => countParagraphs(first)).toBe(1)
    await expect.poll(() => textOf(first)).toBe('第一段第二段')
  })

  test('Shift+Enter 产生换行而不是新段落', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.type('第一行')
    await first.keyboard.press('Shift+Enter')
    await first.keyboard.type('仍在同一段')

    await expect.poll(() => countParagraphs(first)).toBe(1)
    await expect.poll(() => textOf(first)).toBe('第一行\n仍在同一段')
  })

  test('跨段选中删除后只剩一个段落', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.type('第一段')
    await first.keyboard.press('Enter')
    await first.keyboard.type('第二段')
    await expect.poll(() => countParagraphs(first)).toBe(2)

    await first.keyboard.press('Control+A')
    await first.keyboard.press('Delete')
    await expect.poll(() => countParagraphs(first)).toBe(1)
    await expect.poll(() => textOf(first)).toBe('')
  })

  test('纯文本粘贴按换行拆成段落', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)

    // 粘贴携带 HTML 时仍取 text/plain，且不使用 innerHTML 写入。
    await first.getByRole('textbox', { name: '文档正文' }).evaluate((element) => {
      const data = new DataTransfer()
      data.setData('text/plain', '粘贴第一行\n粘贴第二行')
      data.setData('text/html', '<p>粘贴<strong>第一行</strong></p><p>粘贴第二行</p>')
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    })

    await expect.poll(() => countParagraphs(first)).toBe(2)
    await expect.poll(() => textOf(first)).toBe('粘贴第一行\n粘贴第二行')
  })
})

test.describe('双端协作', () => {
  test('一方输入另一方看到变化', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await second.goto(`/#/documents/${documentId}`)
    await expect(second.getByRole('textbox', { name: '文档正文' })).toBeVisible()

    await focusEditor(first)
    await first.keyboard.type('来自第一端')
    await expect.poll(() => textOf(second)).toBe('来自第一端')
  })

  test('两人在同一段内同时输入，双方最终一致', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await second.goto(`/#/documents/${documentId}`)
    await expect(second.getByRole('textbox', { name: '文档正文' })).toBeVisible()

    await focusEditor(first)
    await first.keyboard.type('起始')
    await expect.poll(() => textOf(second)).toBe('起始')

    // 两端各自把光标放到段首，然后几乎同时插入。
    await focusEditor(first)
    await first.keyboard.press('Home')
    await focusEditor(second)
    await second.keyboard.press('Home')

    await Promise.all([first.keyboard.type('甲'), second.keyboard.type('乙')])

    await expect.poll(async () => (await textOf(first)) === (await textOf(second))).toBe(true)
    const merged = await textOf(first)
    expect(merged).toContain('甲')
    expect(merged).toContain('乙')
    expect(merged).toContain('起始')
  })

  test('一方删除后另一方看到删除结果', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await second.goto(`/#/documents/${documentId}`)
    await expect(second.getByRole('textbox', { name: '文档正文' })).toBeVisible()

    await focusEditor(first)
    await first.keyboard.type('abcdef')
    await expect.poll(() => textOf(second)).toBe('abcdef')

    // 两次独立的选区删除；每次都在本端渲染稳定后再操作，
    // 避免按键落在内容尚未同步完成的空编辑器上。
    await expect.poll(() => textOf(second)).toBe('abcdef')
    await focusEditor(second)
    await second.keyboard.press('Home')
    await second.keyboard.press('Shift+ArrowRight')
    await second.keyboard.press('Delete')
    await expect.poll(() => textOf(second)).toBe('bcdef')

    await second.keyboard.press('Home')
    await second.keyboard.press('Shift+ArrowRight')
    await second.keyboard.press('Delete')
    await expect.poll(() => textOf(second)).toBe('cdef')

    await expect.poll(() => textOf(first)).toBe('cdef')
  })

  test('段落结构在两端一致', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await second.goto(`/#/documents/${documentId}`)
    await expect(second.getByRole('textbox', { name: '文档正文' })).toBeVisible()

    await focusEditor(first)
    await first.keyboard.type('第一段')
    await first.keyboard.press('Enter')
    await first.keyboard.type('第二段')

    await expect.poll(() => countParagraphs(second)).toBe(2)
    await expect.poll(() => textOf(second)).toBe('第一段\n第二段')
  })

  test('本地撤销不会把远端内容一起撤掉', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await second.goto(`/#/documents/${documentId}`)
    await expect(second.getByRole('textbox', { name: '文档正文' })).toBeVisible()

    await focusEditor(second)
    await second.keyboard.type('远端保留')
    await expect.poll(() => textOf(first)).toBe('远端保留')

    await focusEditor(first)
    await first.keyboard.type('本地补充')
    await expect.poll(() => textOf(second)).toBe('远端保留本地补充')

    await first.getByRole('button', { name: '撤销' }).click()
    await expect.poll(() => textOf(first)).toBe('远端保留')
    // 远端那次输入不属于本地历史，不能被一起撤销。
    await expect.poll(() => textOf(second)).toBe('远端保留')

    await first.getByRole('button', { name: '重做' }).click()
    await expect.poll(() => textOf(first)).toBe('远端保留本地补充')
    await expect.poll(() => textOf(second)).toBe('远端保留本地补充')
  })
})

test.describe('文档与链接', () => {
  test('不存在的文档不会静默创建', async ({ first }) => {
    await first.goto('/#/documents/00000000-0000-4000-8000-000000000000')
    await expect(first.getByText('文档不存在', { exact: true })).toBeVisible()
    await expect(first.getByRole('textbox', { name: '文档正文' })).toHaveCount(0)
  })

  test('不同文档互不影响', async ({ first, second, openDocument }) => {
    const leftId = await openDocument(first)
    await focusEditor(first)
    await first.keyboard.type('左文档')
    await expect.poll(() => textOf(first)).toBe('左文档')

    const rightId = await openDocument(second)
    expect(rightId).not.toBe(leftId)
    await expect.poll(() => textOf(second)).toBe('')

    await focusEditor(second)
    await second.keyboard.type('右文档')
    await expect.poll(() => textOf(second)).toBe('右文档')
    await expect.poll(() => textOf(first)).toBe('左文档')
  })

  test('保存状态最终显示服务端已保存', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.type('状态检查')
    await expect(first.getByRole('status')).toHaveText('服务端已保存')
  })
})
