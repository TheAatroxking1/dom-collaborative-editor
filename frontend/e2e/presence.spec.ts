import {
  editorText,
  expect,
  focusEditor,
  openDocumentAt,
  pasteText,
  selectLeadingCharacters,
  test,
  waitForConnected,
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

test.describe('协作者鼠标指针', () => {
  test('指向段落中部，另一端在同一段内看到指针', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)

    await focusEditor(first)
    await pasteText(first, '第一段\n第二段\n第三段')
    await expect.poll(() => editorText(second)).toBe('第一段\n第二段\n第三段')

    // 用真实鼠标事件指向第二段，不直接调用生产函数。
    const box = await first.locator('.editor-body > p').nth(1).boundingBox()
    if (box === null) throw new Error('待指向段落没有布局矩形')
    await first.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

    const pointer = second.locator('[data-remote-pointer]')
    await expect(pointer).toHaveCount(1)

    // 不只是「有一个指针」：它的位置必须落在第二端对应的那一段里。
    const target = await second.locator('.editor-body > p').nth(1).boundingBox()
    const marker = await pointer.boundingBox()
    if (target === null || marker === null) throw new Error('指针或段落没有布局矩形')
    expect(marker.x).toBeGreaterThanOrEqual(target.x - 4)
    expect(marker.x).toBeLessThanOrEqual(target.x + target.width + 4)
    expect(marker.y).toBeGreaterThanOrEqual(target.y - 4)
    expect(marker.y).toBeLessThanOrEqual(target.y + target.height + 4)
  })

  test('两端宽度不同时，指针仍落在对应段落内', async ({ browser, backend }) => {
    const documentId = await backend.createDocument()
    // 第一端窄、第二端宽：排版换行不同，指针不能靠原始像素还原。
    const narrow = await browser.newContext({ viewport: { width: 520, height: 720 } })
    const wide = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const narrowPage = await narrow.newPage()
    const widePage = await wide.newPage()
    try {
      await openDocumentAt(narrowPage, documentId)
      await openDocumentAt(widePage, documentId)
      await waitForConnected(widePage)

      await focusEditor(narrowPage)
      await pasteText(
        narrowPage,
        '这一段足够长，用来在窄窗口里产生自动换行，从而让两端排版明显不同\n第二段',
      )
      await expect.poll(() => editorText(widePage)).toContain('第二段')

      const box = await narrowPage.locator('.editor-body > p').first().boundingBox()
      if (box === null) throw new Error('待指向段落没有布局矩形')
      await narrowPage.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6)

      const pointer = widePage.locator('[data-remote-pointer]')
      await expect(pointer).toHaveCount(1)

      const target = await widePage.locator('.editor-body > p').first().boundingBox()
      const marker = await pointer.boundingBox()
      if (target === null || marker === null) throw new Error('指针或段落没有布局矩形')
      expect(marker.y).toBeGreaterThanOrEqual(target.y - 4)
      expect(marker.y).toBeLessThanOrEqual(target.y + target.height + 4)
    } finally {
      await narrow.close()
      await wide.close()
    }
  })

  test('移出正文后指针消失', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)
    await waitForConnected(second)
    await focusEditor(first)
    await first.keyboard.insertText('正文')
    await expect.poll(() => editorText(second)).toBe('正文')

    const box = await first.locator('.editor-body > p').first().boundingBox()
    if (box === null) throw new Error('待指向段落没有布局矩形')
    await first.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await expect(second.locator('[data-remote-pointer]')).toHaveCount(1)

    // 移到正文之外：对端不应再看到指针。
    await first.mouse.move(2, 2)
    await expect(second.locator('[data-remote-pointer]')).toHaveCount(0, { timeout: 20_000 })
  })

  test('断线隐藏远端指针、不影响本地编辑，重连后要等新的移动', async ({
    backend,
    first,
    second,
    openDocument,
  }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)
    await waitForConnected(second)
    await focusEditor(first)
    await first.keyboard.insertText('正文')
    await expect.poll(() => editorText(second)).toBe('正文')

    const box = await first.locator('.editor-body > p').first().boundingBox()
    if (box === null) throw new Error('待指向段落没有布局矩形')
    await first.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await expect(second.locator('[data-remote-pointer]')).toHaveCount(1)

    // 停掉后端让两端真正断线。这里刻意不用浏览器的离线模拟：它不会关闭已经
    // 建立的 WebSocket，连接状态不会变化，也就测不到这条路径。
    await backend.kill()
    await expect(second.locator('[data-remote-pointer]')).toHaveCount(0, { timeout: 20_000 })

    // 断线期间本地编辑完全不受影响。
    await focusEditor(second)
    await second.keyboard.press('End')
    await second.keyboard.insertText('，离线追加')
    await expect.poll(() => editorText(second)).toBe('正文，离线追加')

    // 重连：第一端在断线时已把自己的指针置空，因此不会复活旧像素。
    await backend.restart()
    await waitForConnected(second)
    await expect.poll(() => editorText(first), { timeout: 20_000 }).toBe('正文，离线追加')
    await expect(second.locator('[data-remote-pointer]')).toHaveCount(0)

    // 只有新的移动事件才让指针回来。
    const moved = await first.locator('.editor-body > p').first().boundingBox()
    if (moved === null) throw new Error('待指向段落没有布局矩形')
    await first.mouse.move(moved.x + moved.width * 0.3, moved.y + moved.height / 2)
    await expect(second.locator('[data-remote-pointer]')).toHaveCount(1, { timeout: 20_000 })
  })

  test('切换文档后不残留上一份文档的指针', async ({ first, second, openDocument }) => {
    const firstId = await openDocument(first)
    await openDocumentAt(second, firstId)
    await waitForConnected(second)
    await focusEditor(first)
    await first.keyboard.insertText('第一份')
    await expect.poll(() => editorText(second)).toBe('第一份')

    const box = await first.locator('.editor-body > p').first().boundingBox()
    if (box === null) throw new Error('待指向段落没有布局矩形')
    await first.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await expect(second.locator('[data-remote-pointer]')).toHaveCount(1)

    const secondId = await openDocument(first)
    expect(secondId).not.toBe(firstId)
    await focusEditor(first)
    await first.keyboard.insertText('第二份')

    await expect(second.locator('[data-remote-pointer]')).toHaveCount(0, { timeout: 20_000 })
  })
})
