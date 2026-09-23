import type { Page } from '@playwright/test'

import {
  editorText,
  expect,
  focusEditor,
  openDocumentAt,
  pasteText,
  test,
  waitForConnected,
} from './fixtures'

/**
 * 从正文左侧留白拖动选择整段。
 *
 * 用真实鼠标事件驱动，不直接调用生产函数——否则测的只是算法，不是用户能不能用。
 */

/**
 * 留白内的按下位置：从容器左边缘量起，不是从段落左边缘量起。
 *
 * 正文左内边距比留白宽，段落左侧那一截仍然属于正文区域；按段落坐标往外推会落到
 * 留白之外，拖动就不会开始。
 */
async function gutterX(page: Page): Promise<number> {
  const surface = await page.locator('.editor-surface').boundingBox()
  if (surface === null) throw new Error('编辑器容器没有布局矩形')
  return surface.x + 12
}

/** 拖动选择从 start 到 end 的段落（含两端）。Task 4 也复用这个 helper。 */
export async function dragParagraphs(page: Page, start: number, end: number): Promise<void> {
  const paragraphs = page.locator('.editor-body > p')
  const a = await paragraphs.nth(start).boundingBox()
  const b = await paragraphs.nth(end).boundingBox()
  if (a === null || b === null) throw new Error('待框选段落不存在')

  await page.mouse.move(await gutterX(page), a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + 8, b.y + b.height / 2, { steps: 8 })
  await page.mouse.up()
}

/** 纯竖向拖动：水平位置不动，只在段内上下移动。 */
async function dragVertically(page: Page, start: number, end: number): Promise<void> {
  const paragraphs = page.locator('.editor-body > p')
  const a = await paragraphs.nth(start).boundingBox()
  const b = await paragraphs.nth(end).boundingBox()
  if (a === null || b === null) throw new Error('待框选段落不存在')

  const x = await gutterX(page)
  await page.mouse.move(x, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(x, b.y + b.height / 2, { steps: 8 })
  await page.mouse.up()
}

async function selectedCount(page: Page): Promise<string> {
  return page.locator('[data-selection-count]').innerText()
}

async function prepareThreeParagraphs(page: Page): Promise<void> {
  await focusEditor(page)
  await pasteText(page, '第一段\n第二段\n第三段')
  await expect.poll(() => editorText(page)).toBe('第一段\n第二段\n第三段')
}

test.describe('拖动选段', () => {
  test('从留白拖动选中两段，另一端看到远端高亮', async ({ first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)
    await waitForConnected(second)
    await prepareThreeParagraphs(first)
    await expect.poll(() => editorText(second)).toBe('第一段\n第二段\n第三段')

    await dragParagraphs(first, 0, 1)

    await expect.poll(() => selectedCount(first)).toBe('已选 2 段')
    // 本机高亮两段。
    await expect(first.locator('[data-local-paragraph-selection]')).toHaveCount(2)
    // 另一端看到这两段的远端高亮，且不复制发送者的框选矩形。
    await expect(second.locator('[data-remote-paragraph-selection]')).toHaveCount(2, {
      timeout: 20_000,
    })
    await expect(second.locator('[data-selection-drag]')).toHaveCount(0)
    // 选区是临时状态，正文不变。
    await expect.poll(() => editorText(second)).toBe('第一段\n第二段\n第三段')
  })

  test('纯竖向拖动也能选段', async ({ first, openDocument }) => {
    await openDocument(first)
    await prepareThreeParagraphs(first)

    // 只上下移动，水平位置始终在留白里：命中判定包含段落左侧留白。
    await dragVertically(first, 0, 2)
    await expect.poll(() => selectedCount(first)).toBe('已选 3 段')
  })

  test('反向拖动同样按范围选中', async ({ first, openDocument }) => {
    await openDocument(first)
    await prepareThreeParagraphs(first)

    await dragParagraphs(first, 2, 1)
    await expect.poll(() => selectedCount(first)).toBe('已选 2 段')
    await expect(first.locator('[data-local-paragraph-selection]')).toHaveCount(2)
  })

  test('空段落也能被选中', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await pasteText(first, '有内容\n\n最后一段')
    await expect.poll(() => editorText(first)).toBe('有内容\n\n最后一段')

    await dragParagraphs(first, 1, 1)
    await expect.poll(() => selectedCount(first)).toBe('已选 1 段')
  })

  test('正文内拖动仍然是选中文字，不进入整段框选', async ({ first, openDocument }) => {
    await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('abcdef')
    await expect.poll(() => editorText(first)).toBe('abcdef')

    const box = await first.locator('.editor-body > p').first().boundingBox()
    if (box === null) throw new Error('正文没有布局矩形')
    await first.mouse.move(box.x + 4, box.y + box.height / 2)
    await first.mouse.down()
    await first.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 6 })
    await first.mouse.up()

    // 有文字选区，但没有整段选区。
    const selection = await first.evaluate(() => String(window.getSelection()?.toString()))
    expect(selection.length).toBeGreaterThan(0)
    await expect(first.locator('[data-selection-count]')).toHaveCount(0)
    await expect(first.locator('[data-local-paragraph-selection]')).toHaveCount(0)
  })

  test('点击正文清除整段选区，同时照常定位文字光标', async ({ first, openDocument }) => {
    await openDocument(first)
    await prepareThreeParagraphs(first)
    await dragParagraphs(first, 0, 1)
    await expect.poll(() => selectedCount(first)).toBe('已选 2 段')

    const box = await first.locator('.editor-body > p').nth(2).boundingBox()
    if (box === null) throw new Error('正文没有布局矩形')
    await first.mouse.click(box.x + 10, box.y + box.height / 2)

    await expect(first.locator('[data-selection-count]')).toHaveCount(0)
    await expect(first.locator('[data-local-paragraph-selection]')).toHaveCount(0)
    // 文字定位仍然生效：接着输入会进入被点击的那一段。
    await first.keyboard.insertText('X')
    await expect.poll(() => editorText(first)).toContain('X')
  })

  test('拖动结束后抬起鼠标不会把刚选的内容清掉', async ({ first, openDocument }) => {
    await openDocument(first)
    await prepareThreeParagraphs(first)

    await dragParagraphs(first, 0, 1)
    await expect.poll(() => selectedCount(first)).toBe('已选 2 段')

    // 紧随拖动会产生一次 click；它不能清掉选区。
    await first.waitForTimeout(300)
    await expect.poll(() => selectedCount(first)).toBe('已选 2 段')
  })

  test('Escape 清除选区', async ({ first, openDocument }) => {
    await openDocument(first)
    await prepareThreeParagraphs(first)
    await dragParagraphs(first, 0, 1)
    await expect.poll(() => selectedCount(first)).toBe('已选 2 段')

    await first.locator('.editor-surface').press('Escape')
    await expect(first.locator('[data-selection-count]')).toHaveCount(0)
  })

  test('点击工具栏不会提前清掉选区', async ({ first, openDocument }) => {
    await openDocument(first)
    await prepareThreeParagraphs(first)
    await dragParagraphs(first, 0, 1)
    await expect.poll(() => selectedCount(first)).toBe('已选 2 段')

    // 用复制正文：它只动剪贴板，不会像「撤销」那样改动正文进而改变选区。
    await first.getByRole('button', { name: '复制正文' }).click()
    await expect.poll(() => selectedCount(first)).toBe('已选 2 段')
  })
})

test.describe('段落引用的身份', () => {
  test('另一端在前面插入新段，本机选中的仍是原来那两段', async ({
    first,
    second,
    openDocument,
  }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)
    await waitForConnected(second)
    await prepareThreeParagraphs(first)

    await dragParagraphs(first, 1, 2)
    await expect.poll(() => selectedCount(first)).toBe('已选 2 段')

    // 另一端在最前面插入一段：下标全变了，引用不能跟着变。
    await focusEditor(second)
    await second.keyboard.press('Control+Home')
    await second.keyboard.insertText('插入段')
    await second.keyboard.press('Enter')
    await expect.poll(() => editorText(first)).toContain('插入段')

    // 仍然是「第二段」「第三段」被选中，新段不自动加入。
    await expect.poll(() => selectedCount(first)).toBe('已选 2 段')

    // 第一段（刚插入的那一段）不能落在高亮范围内：存下标的话这里就会选中它。
    const inserted = await first.locator('.editor-body > p').first().boundingBox()
    const highlights = await first.locator('[data-local-paragraph-selection]').evaluateAll(
      (nodes) => nodes.map((node) => node.getBoundingClientRect().top),
    )
    if (inserted === null) throw new Error('插入段没有布局矩形')
    expect(Math.min(...highlights)).toBeGreaterThan(inserted.y + inserted.height / 2)
  })

  test('另一端删掉被选中的段落时，剩余选区不退化到邻段', async ({
    first,
    second,
    openDocument,
  }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)
    await waitForConnected(second)
    await prepareThreeParagraphs(first)

    // 选中「第二段」和「第三段」。
    await dragParagraphs(first, 1, 2)
    await expect.poll(() => selectedCount(first)).toBe('已选 2 段')

    // 另一端选中「第二段」整段（到「第三段」开头）并删除，把两段合并。
    await focusEditor(second)
    await second.keyboard.press('Control+Home')
    await second.keyboard.press('ArrowDown')
    await second.keyboard.press('Shift+ArrowDown')
    await second.keyboard.press('Delete')
    await expect.poll(() => editorText(first)).toBe('第一段\n第三段')

    // 失效的那一段被移除，存活的那一段仍然选中；绝不能退化成下标而去选第一段。
    await expect.poll(() => selectedCount(first)).toBe('已选 1 段')
    const remaining = await first.locator('.editor-body > p').nth(1).boundingBox()
    const highlight = await first
      .locator('[data-local-paragraph-selection]')
      .evaluate((node) => node.getBoundingClientRect().top)
    if (remaining === null) throw new Error('剩余段落没有布局矩形')
    expect(highlight).toBeGreaterThan(remaining.y - 4)
    expect(highlight).toBeLessThan(remaining.y + remaining.height + 4)
  })

  test('切换文档后不残留段落选区', async ({ first, openDocument }) => {
    const firstId = await openDocument(first)
    await prepareThreeParagraphs(first)
    await dragParagraphs(first, 0, 1)
    await expect.poll(() => selectedCount(first)).toBe('已选 2 段')

    const secondId = await openDocument(first)
    expect(secondId).not.toBe(firstId)

    await expect(first.locator('[data-selection-count]')).toHaveCount(0)
    await expect(first.locator('[data-local-paragraph-selection]')).toHaveCount(0)
  })
})
