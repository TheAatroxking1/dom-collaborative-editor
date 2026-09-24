import { test, expect, openDocumentAt, waitForConnected, focusEditor, pasteText } from './fixtures'

test('连续输入使页面自动滚动后，静止鼠标仍定位在当前所在的位置', async ({ first, second, openDocument }) => {
  await first.setViewportSize({ width: 1000, height: 600 })
  await second.setViewportSize({ width: 1000, height: 600 })
  const id = await openDocument(first)
  await openDocumentAt(second, id)
  await waitForConnected(second)
  await focusEditor(first)
  const box = await first.locator('.editor-surface').boundingBox()
  if (!box) throw new Error('输入区域没有布局矩形')
  const mouse = { x: box.x + box.width * 0.7, y: Math.min(box.y + box.height * 0.8, 550) }
  await first.mouse.move(mouse.x, mouse.y)
  const pointer = second.locator('[data-remote-pointer]')
  await expect(pointer).toHaveCount(1)

  // 不再移动鼠标；连续输入真实触发 ProseMirror 自动滚动及编辑区域增高。
  for (let index = 0; index < 20; index++) {
    await first.keyboard.insertText(`第${index + 1}行文字`)
    await first.keyboard.press('Enter')
  }
  await expect(second.locator('.editor-body > p')).toHaveCount(21)
  await expect.poll(() => first.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  // 对齐阅读区域后，远端必须显示鼠标现在的位置，而不是输入之前的旧比例坐标。
  const scroll = await first.evaluate(() => window.scrollY)
  await second.evaluate((top) => window.scrollTo(0, top), scroll)
  await expect(pointer).toHaveCount(1)
  await expect.poll(async () => Math.abs((await pointer.boundingBox())!.y + 2 - mouse.y))
    .toBeLessThanOrEqual(3)
  await expect.poll(async () => Math.abs((await pointer.boundingBox())!.x + 2 - mouse.x))
    .toBeLessThanOrEqual(3)
})

test('屏幕外的鼠标不显示，阅读区域滚到对应位置后显示', async ({ first, second, openDocument }) => {
  await first.setViewportSize({ width: 1000, height: 600 })
  await second.setViewportSize({ width: 1000, height: 600 })
  const id = await openDocument(first)
  await openDocumentAt(second, id)
  await focusEditor(first)
  await pasteText(first, Array.from({ length: 30 }, (_, i) => `第${i + 1}行`).join('\n'))
  await expect(second.locator('.editor-body > p')).toHaveCount(30)
  const last = await first.locator('.editor-body > p').last().boundingBox()
  if (!last) throw new Error('段落没有布局矩形')
  await first.mouse.move(last.x + last.width / 2, last.y + last.height / 2)
  const pointer = second.locator('[data-remote-pointer]')
  // 同步已完成，但接收端还在文档顶部，不画屏幕外的标记。
  await expect(pointer).toHaveCount(0)
  expect(await second.evaluate(() => window.scrollY)).toBe(0)
  await second.locator('.editor-body > p').last().scrollIntoViewIfNeeded()
  await expect(pointer).toHaveCount(1)
  const marker = await pointer.boundingBox()
  expect(marker!.y).toBeGreaterThanOrEqual(0)
  expect(marker!.y).toBeLessThan(600)
  await second.evaluate(() => window.scrollTo(0, 0))
  await expect(pointer).toHaveCount(0)
})

test('指针停止移动后不会因双方 Awareness 更新循环发送消息', async ({ first, second, openDocument }) => {
  let sent = 0
  for (const page of [first, second]) {
    page.on('websocket', (socket) => socket.on('framesent', () => sent++))
  }
  const id = await openDocument(first)
  await openDocumentAt(second, id)
  await waitForConnected(second)
  for (const page of [first, second]) {
    const box = await page.locator('.editor-surface').boundingBox()
    if (!box) throw new Error('输入区域没有布局矩形')
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.8)
  }
  await expect(first.locator('[data-remote-pointer]')).toHaveCount(1)
  await expect(second.locator('[data-remote-pointer]')).toHaveCount(1)
  // 此处测的是一段时间内的网络流量：给在途消息留出时间，再观察多个 50ms 节流周期。
  await first.waitForTimeout(300)
  const baseline = sent
  await first.waitForTimeout(400)
  // 容许一次偶发的库心跳；持续回声会在这个窗口内发送多条消息。
  expect(sent - baseline).toBeLessThanOrEqual(2)
})

test('鼠标离开后，滚动和窗口调整不会恢复旧指针', async ({ first, second, openDocument }) => {
  const id = await openDocument(first)
  await openDocumentAt(second, id)
  await waitForConnected(second)
  const box = await first.locator('.editor-surface').boundingBox()
  if (!box) throw new Error('输入区域没有布局矩形')
  await first.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.8)
  const pointer = second.locator('[data-remote-pointer]')
  await expect(pointer).toHaveCount(1)
  await first.mouse.move(2, 2)
  await expect(pointer).toHaveCount(0)
  await first.setViewportSize({ width: 1000, height: 500 })
  await first.evaluate(() => window.scrollTo(0, 100))
  // 等待重测与节流发布，确认旧的输入框坐标不会重新广播。
  await first.waitForTimeout(200)
  await expect(pointer).toHaveCount(0)
})
