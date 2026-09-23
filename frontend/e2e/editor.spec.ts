import {
  editorParagraphCount as countParagraphs,
  editorText as textOf,
  expect,
  focusEditor,
  openDocumentAt,
  selectLeadingCharacters,
  settleSelection,
  test,
  waitForConnected,
} from './fixtures'

test.describe('单人编辑', () => {
  test('新建文档后地址栏带上文档标识，编辑器可输入', async ({ first }) => {
    await first.goto('/')
    await first.getByRole('button', { name: '新建文档' }).click()

    await expect(first).toHaveURL(/#\/documents\/[0-9a-f-]{36}$/)
    await expect(first.getByRole('textbox', { name: '文档正文' })).toBeVisible()

    await focusEditor(first)
    await first.keyboard.insertText('中文English🙂')
    await expect.poll(() => textOf(first)).toBe('中文English🙂')
  })

  test('刷新页面后正文仍在', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('刷新前写入的内容')
    await expect.poll(() => textOf(first)).toBe('刷新前写入的内容')

    await first.reload()
    await expect(first.getByRole('textbox', { name: '文档正文' })).toBeVisible()
    await expect.poll(() => textOf(first)).toBe('刷新前写入的内容')
  })

  test('退格与 Delete 分别删除光标前后的字符', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('abcdef')
    await first.keyboard.press('Backspace')
    await expect.poll(() => textOf(first)).toBe('abcde')

    await first.keyboard.press('Home')
    await settleSelection(first)
    await first.keyboard.press('Delete')
    await expect.poll(() => textOf(first)).toBe('bcde')
  })

  test('回车拆出第二段，退格在段首把两段合并回去', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('第一段')
    await first.keyboard.press('Enter')
    await first.keyboard.insertText('第二段')
    await expect.poll(() => countParagraphs(first)).toBe(2)
    await expect.poll(() => textOf(first)).toBe('第一段\n第二段')

    // 打字后光标在第二段末尾，先回到段首，退格才会把两段合并。
    await first.keyboard.press('Home')
    await settleSelection(first)
    await first.keyboard.press('Backspace')
    await expect.poll(() => countParagraphs(first)).toBe(1)
    await expect.poll(() => textOf(first)).toBe('第一段第二段')
  })

  test('Shift+Enter 产生换行而不是新段落', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('第一行')
    await first.keyboard.press('Shift+Enter')
    await first.keyboard.insertText('仍在同一段')

    await expect.poll(() => countParagraphs(first)).toBe(1)
    await expect.poll(() => textOf(first)).toBe('第一行\n仍在同一段')
  })

  test('跨段选中删除后只剩一个段落', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('第一段')
    await first.keyboard.press('Enter')
    await first.keyboard.insertText('第二段')
    await expect.poll(() => countParagraphs(first)).toBe(2)

    await first.keyboard.press('Control+A')
    await settleSelection(first)
    await expect
      .poll(() => first.evaluate(() => String(window.getSelection()?.toString())))
      .toContain('第一段')
    await first.keyboard.press('Delete')
    await expect.poll(() => countParagraphs(first)).toBe(1)
    await expect.poll(() => textOf(first)).toBe('')
  })

  test('在段落中间粘贴单行文本不会拆成三段', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('abcd')

    // 光标移到 ab 与 cd 之间，粘贴不含换行的文本。
    await first.keyboard.press('Home')
    await settleSelection(first)
    await first.keyboard.press('ArrowRight')
    await settleSelection(first)
    await first.keyboard.press('ArrowRight')
    await settleSelection(first)

    await first.getByRole('textbox', { name: '文档正文' }).evaluate((element) => {
      const data = new DataTransfer()
      data.setData('text/plain', 'X')
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    })

    // 必须是 abXcd 一段，而不是 ab / X / cd 三段。
    await expect.poll(() => countParagraphs(first)).toBe(1)
    await expect.poll(() => textOf(first)).toBe('abXcd')
  })

  test('在段落中间粘贴多行文本时首行接前缀、末行接后缀', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('abcd')

    await first.keyboard.press('Home')
    await settleSelection(first)
    for (let index = 0; index < 2; index += 1) {
      await first.keyboard.press('ArrowRight')
      await settleSelection(first)
    }

    await first.getByRole('textbox', { name: '文档正文' }).evaluate((element) => {
      const data = new DataTransfer()
      data.setData('text/plain', 'X\nY')
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    })

    await expect.poll(() => countParagraphs(first)).toBe(2)
    await expect.poll(() => textOf(first)).toBe('abX\nYcd')
  })

  test('粘贴只取纯文本，且按换行拆成段落', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)

    // 剪贴板同时提供 HTML 与纯文本，且两者内容不同：
    // 只有真的走了 text/plain 才会得到下面断言的结果。
    await first.getByRole('textbox', { name: '文档正文' }).evaluate((element) => {
      const data = new DataTransfer()
      data.setData('text/plain', '纯文本第一行\n纯文本第二行')
      data.setData('text/html', '<p>HTML内容</p><p>不该出现</p>')
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    })

    await expect.poll(() => countParagraphs(first)).toBe(2)
    await expect.poll(() => textOf(first)).toBe('纯文本第一行\n纯文本第二行')
    expect(await textOf(first)).not.toContain('HTML')
  })

  test('复制正文时 Shift+Enter 的换行不会丢失', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('第一行')
    await first.keyboard.press('Shift+Enter')
    await first.keyboard.insertText('第二行')
    await first.keyboard.press('Enter')
    await first.keyboard.insertText('第二段')

    await first.getByRole('button', { name: '复制正文' }).click()
    await expect(first.getByText('已复制正文')).toBeVisible()

    // Windows 剪贴板会把换行规范成 CRLF，比较前统一回来。
    const copied = (await first.evaluate(() => navigator.clipboard.readText())).replace(
      /\r\n/g,
      '\n',
    )
    expect(copied).toBe('第一行\n第二行\n第二段')
  })
})

test.describe('双端协作', () => {
  test('一方输入另一方看到变化', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)

    await focusEditor(first)
    await first.keyboard.insertText('来自第一端')
    await expect.poll(() => textOf(second)).toBe('来自第一端')
  })

  test('两人在同一段内同时输入，双方最终一致', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)

    await focusEditor(first)
    await first.keyboard.insertText('起始')
    await expect.poll(() => textOf(second)).toBe('起始')

    // 两端各自把光标放到段首，然后几乎同时插入。
    await focusEditor(first)
    await first.keyboard.press('Home')
    await settleSelection(first)
    await focusEditor(second)
    await second.keyboard.press('Home')
    await settleSelection(second)

    await Promise.all([first.keyboard.insertText('甲'), second.keyboard.insertText('乙')])

    await expect.poll(async () => (await textOf(first)) === (await textOf(second))).toBe(true)
    const merged = await textOf(first)
    expect(merged).toContain('甲')
    expect(merged).toContain('乙')
    expect(merged).toContain('起始')
  })

  test('一端删除后另一端看到删除结果', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)

    await focusEditor(first)
    await first.keyboard.insertText('abcdef')
    await expect.poll(() => textOf(second)).toBe('abcdef')

    await selectLeadingCharacters(second, 2)
    await second.keyboard.press('Delete')
    await expect.poll(() => textOf(second)).toBe('cdef')
    await expect.poll(() => textOf(first)).toBe('cdef')
  })

  test('段落结构在两端一致', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)

    await focusEditor(first)
    await first.keyboard.insertText('第一段')
    await first.keyboard.press('Enter')
    await first.keyboard.insertText('第二段')

    await expect.poll(() => countParagraphs(second)).toBe(2)
    await expect.poll(() => textOf(second)).toBe('第一段\n第二段')
  })

  test('远端更新期间本端焦点与选区不被重置', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('一二三四五')
    await expect.poll(() => textOf(first)).toBe('一二三四五')

    await openDocumentAt(second, documentId)
    await expect.poll(() => textOf(second)).toBe('一二三四五')

    await selectLeadingCharacters(second, 2)
    await expect
      .poll(() => second.evaluate(() => String(window.getSelection()?.toString())))
      .toBe('一二')

    await focusEditor(first)
    await first.keyboard.press('End')
    await settleSelection(first)
    await first.keyboard.insertText('末尾')
    await expect.poll(() => textOf(second)).toBe('一二三四五末尾')

    expect(await second.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
      '文档正文',
    )
    expect(await second.evaluate(() => String(window.getSelection()?.toString()))).toBe('一二')
  })

  test('本地撤销不会把远端内容一起撤掉', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)

    await focusEditor(second)
    await second.keyboard.insertText('远端保留')
    await expect.poll(() => textOf(first)).toBe('远端保留')

    await focusEditor(first)
    await first.keyboard.insertText('本地补充')
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

    await expect(first.getByText(/文档不存在/)).toBeVisible()
    await expect(first.getByRole('textbox', { name: '文档正文' })).toHaveCount(0)
  })

  test('不同文档互不影响', async ({ first, second, openDocument }) => {
    const leftId = await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('左文档')
    await expect.poll(() => textOf(first)).toBe('左文档')

    const rightId = await openDocument(second)
    expect(rightId).not.toBe(leftId)
    await expect.poll(() => textOf(second)).toBe('')

    await focusEditor(second)
    await second.keyboard.insertText('右文档')
    await expect.poll(() => textOf(second)).toBe('右文档')
    await expect.poll(() => textOf(first)).toBe('左文档')
  })

  test('连接成功后显示已连接', async ({ first, openDocument }) => {
    await openDocument(first)
    await waitForConnected(first)

    await focusEditor(first)
    await first.keyboard.insertText('连接状态')
    await expect.poll(() => first.getByRole('status').innerText()).toBe('已连接')
  })
})
