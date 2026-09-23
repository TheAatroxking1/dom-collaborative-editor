import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import * as Y from 'yjs'

import { serializeBackup } from '../src/documents/backup'
import {
  ALTERNATE_ORIGIN,
  editorText,
  expect,
  focusEditor,
  PRODUCTION_ORIGIN,
  selectLeadingCharacters,
  test,
  waitForConnected,
} from './fixtures'

/**
 * 换地址迁移的验收：导出完整 Yjs 备份，在另一个 origin 打开同一份文档并合并。
 *
 * 两个 origin 指向同一个 Python 进程，因此「服务端数据相同、浏览器存储不同」这个
 * 前提是真实的——正是换 IP/端口/协议后用户遇到的情形。
 */

function documentUrl(origin: string, documentId: string): string {
  return `${origin}/#/documents/${documentId}`
}

async function openAt(page: Page, origin: string, documentId: string): Promise<void> {
  await page.goto(documentUrl(origin, documentId))
  await expect(page.getByRole('textbox', { name: '文档正文' })).toBeVisible()
}

/** 面板里的反馈区域。限定作用域，避免与页面其它提示混淆。 */
function panelAlert(page: Page) {
  return page.locator('.backup-panel').getByRole('alert')
}

function panelStatus(page: Page) {
  return page.locator('.backup-panel').getByRole('status')
}

async function exportBackup(page: Page): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'collab-backup-'))
  const target = join(directory, 'source.collab-backup.json')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出当前正文' }).click()
  await (await download).saveAs(target)
  return target
}

async function chooseBackup(page: Page, path: string): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(path)
  await expect(page.getByRole('textbox', { name: '备份正文预览' })).toBeVisible()
}

function previewText(page: Page): Promise<string> {
  return page.getByRole('textbox', { name: '备份正文预览' }).inputValue()
}

async function paragraphCount(page: Page): Promise<number> {
  return page.getByRole('textbox', { name: '文档正文' }).locator('p').count()
}

async function merge(page: Page): Promise<void> {
  await page.getByRole('button', { name: '合并备份' }).click()
}

/** 造一个内容任意但结构合法的备份文件，用来测各种拒绝路径。 */
function writeRawBackup(name: string, content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'collab-bad-'))
  const target = join(directory, name)
  writeFileSync(target, content, 'utf8')
  return target
}

/**
 * 造一个指定正文的备份文件。
 *
 * `padding` 用尾随空格把 JSON 撑大——尾随空白是合法 JSON，因此文件依然能通过
 * 校验，但读取与解析会明显变慢，用来制造「先选的文件读得慢」这个时序。
 */
function writeBackupFile(
  name: string,
  documentId: string,
  text: string,
  padding = 0,
): string {
  const doc = new Y.Doc()
  const paragraph = new Y.XmlElement('paragraph')
  doc.getXmlFragment('body').push([paragraph])
  const node = new Y.XmlText()
  paragraph.push([node])
  node.insert(0, text)

  const json = serializeBackup(documentId, doc, PRODUCTION_ORIGIN)
  doc.destroy()

  const directory = mkdtempSync(join(tmpdir(), 'collab-race-'))
  const target = join(directory, name)
  writeFileSync(target, padding > 0 ? json + ' '.repeat(padding) : json, 'utf8')
  return target
}

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * 让「大文件的读取更慢」这件事真的发生。
 *
 * 页面内构造的 File 背后是内存里的字符串，大小并不带来 I/O 差异；而现实里大文件
 * 从磁盘读取明显更慢，这正是竞态的成因。这里给 File.prototype.text 加一个与体积
 * 相关的延时来还原那个条件——被测试的组件代码一行都没有改动。
 */
async function slowDownLargeFileReads(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const original = File.prototype.text
    File.prototype.text = function patched(this: File): Promise<string> {
      const delay = this.size > 1_000_000 ? 300 : 0
      return new Promise<string>((resolve, reject) => {
        setTimeout(() => {
          original.call(this).then(resolve, reject)
        }, delay)
      })
    }
  })
}

/**
 * 在一个页面内同步派发两次文件选择，制造真实的交错。
 *
 * 为什么不用 `setInputFiles` 连续设置：那两次之间隔着一次 CDP 往返（几十毫秒），
 * 足够第一次读取完成，竞态窗口根本不会出现——测试会假通过。
 *
 * 只用浏览器自身的 File / DataTransfer / change 事件，不替换被测代码的任何部分。
 * 第二个名字为空字符串表示清空选择。
 */
async function dispatchTwoFileSelections(
  page: Page,
  firstText: string,
  secondText: string,
  names: { firstName: string; secondName: string },
): Promise<void> {
  await page.evaluate(
    ({ first, second, firstName, secondName }) => {
      const input = document.querySelector<HTMLInputElement>('.backup-file-input')
      if (input === null) throw new Error('找不到文件选择输入框')

      const choose = (content: string, name: string): void => {
        const transfer = new DataTransfer()
        if (name.length > 0) {
          transfer.items.add(new File([content], name, { type: 'application/json' }))
        }
        input.files = transfer.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }

      choose(first, firstName)
      choose(second, secondName)
    },
    {
      first: firstText,
      second: secondText,
      firstName: names.firstName,
      secondName: names.secondName,
    },
  )
}

type Pages = { contexts: BrowserContext[]; pages: Page[] }

/** 打开的页面在测试结束时统一关闭。 */
async function openPages(
  browser: Browser,
  targets: Array<{ origin: string; documentId: string; waitConnected?: boolean }>,
): Promise<Pages> {
  const contexts: BrowserContext[] = []
  const pages: Page[] = []
  for (const target of targets) {
    // 每个 origin 用独立 context：127.0.0.1 与 localhost 是两份不同的浏览器存储。
    const context = await browser.newContext({ serviceWorkers: 'allow' })
    const page = await context.newPage()
    await openAt(page, target.origin, target.documentId)
    if (target.waitConnected !== false) await waitForConnected(page)
    contexts.push(context)
    pages.push(page)
  }
  return { contexts, pages }
}

async function closeAll({ contexts }: Pages): Promise<void> {
  for (const context of contexts) await context.close()
}

test.describe('换地址迁移', () => {
  test('离线插入与删除都随备份迁移，并在两端收敛', async ({ browser, server }) => {
    const documentId = await server.createDocument()
    const opened = await openPages(browser, [
      { origin: PRODUCTION_ORIGIN, documentId },
      { origin: ALTERNATE_ORIGIN, documentId },
    ])
    const [firstPage, secondPage] = opened.pages as [Page, Page]

    try {
      await focusEditor(firstPage)
      await firstPage.keyboard.insertText('共同起点')
      await expect.poll(() => editorText(secondPage), { timeout: 20_000 }).toBe('共同起点')

      // 第一个地址离线编辑：一段插入、一处删除。
      await opened.contexts[0]!.setOffline(true)
      await focusEditor(firstPage)
      await firstPage.keyboard.press('End')
      await firstPage.keyboard.insertText('，离线新增')
      await expect.poll(() => editorText(firstPage)).toBe('共同起点，离线新增')

      await selectLeadingCharacters(firstPage, 4)
      await firstPage.keyboard.press('Delete')
      await expect.poll(() => editorText(firstPage)).toBe('，离线新增')

      // 另一个地址此时并发编辑。
      await focusEditor(secondPage)
      await secondPage.keyboard.press('End')
      await secondPage.keyboard.insertText('，在线新增')
      await expect.poll(() => editorText(secondPage)).toBe('共同起点，在线新增')

      const backupPath = await exportBackup(firstPage)

      // 目标端在线打开同一 UUID，导入两次。
      await chooseBackup(secondPage, backupPath)
      await expect.poll(() => previewText(secondPage)).toBe('，离线新增')
      await merge(secondPage)
      await expect(panelStatus(secondPage)).toContainText('备份已合并', { timeout: 20_000 })

      const afterFirstImport = await editorText(secondPage)
      expect(afterFirstImport).toContain('离线新增')
      expect(afterFirstImport).toContain('在线新增')
      expect(afterFirstImport).not.toContain('共同起点')

      // 同一份备份再导一次：不得重复插入。
      await chooseBackup(secondPage, backupPath)
      await merge(secondPage)
      await expect(panelStatus(secondPage)).toContainText('备份已合并', { timeout: 20_000 })
      expect(await editorText(secondPage)).toBe(afterFirstImport)
      expect(await paragraphCount(secondPage)).toBe(1)

      // 刷新后仍在；恢复第一个地址的网络，两端收敛到同样内容。
      await secondPage.reload()
      await expect.poll(() => editorText(secondPage), { timeout: 20_000 }).toBe(afterFirstImport)

      await opened.contexts[0]!.setOffline(false)
      await expect.poll(() => editorText(firstPage), { timeout: 20_000 }).toBe(afterFirstImport)
    } finally {
      await closeAll(opened)
    }
  })

  test('备份属于另一个文档时只提供打开原文档，不写入当前正文', async ({ browser, server }) => {
    const sourceId = await server.createDocument()
    const targetId = await server.createDocument()
    // 两个页面刻意打开不同的文档。
    const opened = await openPages(browser, [
      { origin: PRODUCTION_ORIGIN, documentId: sourceId },
      { origin: ALTERNATE_ORIGIN, documentId: targetId },
    ])
    const [sourcePage, targetPage] = opened.pages as [Page, Page]

    try {
      await focusEditor(sourcePage)
      await sourcePage.keyboard.insertText('原文档的内容')
      await expect.poll(() => editorText(sourcePage)).toBe('原文档的内容')

      await focusEditor(targetPage)
      await targetPage.keyboard.insertText('当前文档的内容')
      await expect.poll(() => editorText(targetPage)).toBe('当前文档的内容')

      const backupPath = await exportBackup(sourcePage)

      await chooseBackup(targetPage, backupPath)

      // 只提供「打开原文档」，不提供合并，当前正文不变。
      await expect(panelAlert(targetPage)).toContainText('属于另一个文档')
      await expect(targetPage.getByRole('button', { name: '合并备份' })).toHaveCount(0)
      expect(await editorText(targetPage)).toBe('当前文档的内容')

      // 点「打开原文档」跳到备份里的文档，且文件仍保留。
      await targetPage.getByRole('button', { name: '打开原文档' }).click()
      await expect.poll(() => targetPage.url()).toContain(sourceId)
      await expect(targetPage.getByRole('textbox', { name: '备份正文预览' })).toBeVisible()
      await expect.poll(() => previewText(targetPage)).toBe('原文档的内容')
    } finally {
      await closeAll(opened)
    }
  })

  test('损坏或不支持的备份被拒绝，且不影响当前正文', async ({ browser, server }) => {
    const documentId = await server.createDocument()
    const opened = await openPages(browser, [
      { origin: PRODUCTION_ORIGIN, documentId },
    ])
    const [page] = opened.pages as [Page]

    try {
      await focusEditor(page)
      await page.keyboard.insertText('必须保留的正文')
      await expect.poll(() => editorText(page)).toBe('必须保留的正文')

      const cases: Array<[string, string, RegExp]> = [
        ['broken.json', '{不是 json', /JSON|备份/],
        [
          'wrong-format.json',
          JSON.stringify({ format: 'other', version: 1, schema: 'x' }),
          /格式/,
        ],
        [
          'bad-uuid.json',
          JSON.stringify({
            format: 'dom-collab-backup',
            version: 1,
            schema: 'paragraph-text-hardbreak-v1',
            documentId: 'nope',
            exportedAt: '2026-01-01T00:00:00.000Z',
            sourceOrigin: 'http://127.0.0.1:5483',
            updateBase64: 'AAAA',
          }),
          /UUID|标识/,
        ],
      ]

      for (const [name, content, message] of cases) {
        await page.locator('input[type="file"]').setInputFiles(writeRawBackup(name, content))
        await expect(panelAlert(page)).toContainText(message, { timeout: 10_000 })
        expect(await editorText(page)).toBe('必须保留的正文')
      }

      // 结构合法但正文数据损坏的备份也要被拒绝。
      const valid = await exportBackup(page)
      const payload = JSON.parse(readFileSync(valid, 'utf8')) as Record<string, unknown>
      await page
        .locator('input[type="file"]')
        .setInputFiles(writeRawBackup('corrupted.json', JSON.stringify({ ...payload, updateBase64: 'QUJD' })))
      await expect(panelAlert(page)).toContainText(/无法解析|Base64/, { timeout: 10_000 })

      expect(await editorText(page)).toBe('必须保留的正文')
      expect(await paragraphCount(page)).toBe(1)
    } finally {
      await closeAll(opened)
    }
  })

  test('服务端没有这份文档时保留预览并说明，不自动新建文档', async ({ browser, server }) => {
    const documentId = await server.createDocument()
    const opened = await openPages(browser, [{ origin: PRODUCTION_ORIGIN, documentId }])
    const [page] = opened.pages as [Page]

    try {
      await focusEditor(page)
      await page.keyboard.insertText('本地还留着的正文')
      await expect.poll(() => editorText(page)).toBe('本地还留着的正文')
      const backupPath = await exportBackup(page)

      // 让服务端不再认识这份文档（只动测试自己的临时数据）。
      await server.removeDocumentFromDirectory(documentId)

      await chooseBackup(page, backupPath)
      await merge(page)

      await expect(panelAlert(page)).toContainText('当前服务器上没有这份文档', { timeout: 20_000 })
      // 预览保留，正文不变，也不会悄悄创建新文档。
      await expect(page.getByRole('textbox', { name: '备份正文预览' })).toBeVisible()
      expect(await previewText(page)).toBe('本地还留着的正文')

      const response = await fetch(`${PRODUCTION_ORIGIN}/api/documents/${documentId}`)
      expect(response.status).toBe(404)
    } finally {
      await closeAll(opened)
    }
  })

  test('合并前的在线校验超时会明确失败，不写入正文', async ({ browser, server }) => {
    const documentId = await server.createDocument()
    const opened = await openPages(browser, [{ origin: PRODUCTION_ORIGIN, documentId }])
    const [page] = opened.pages as [Page]

    try {
      await focusEditor(page)
      await page.keyboard.insertText('等待校验的正文')
      const backupPath = await exportBackup(page)
      await chooseBackup(page, backupPath)

      // 让校验请求挂住超过组件的 8 秒上限。
      await page.route(`**/api/documents/${documentId}`, async (route) => {
        await new Promise((settle) => setTimeout(settle, 12_000))
        await route.continue()
      })

      await merge(page)
      await expect(panelAlert(page)).toContainText(/无法连接服务端|超时/, { timeout: 30_000 })
      expect(await editorText(page)).toBe('等待校验的正文')
    } finally {
      await closeAll(opened)
    }
  })

  test('校验期间切换文档时不写入新文档', async ({ browser, server }) => {
    const firstId = await server.createDocument()
    const secondId = await server.createDocument()
    const opened = await openPages(browser, [{ origin: PRODUCTION_ORIGIN, documentId: firstId }])
    const [page] = opened.pages as [Page]

    try {
      await focusEditor(page)
      await page.keyboard.insertText('第一份文档的正文')
      const backupPath = await exportBackup(page)
      await chooseBackup(page, backupPath)

      // 把校验请求挂住，期间切到另一个文档。
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route(`**/api/documents/${firstId}`, async (route) => {
        await held
        await route.continue()
      })

      await merge(page)

      // 用路由切换文档（真实用法），而不是整页导航：组件保持挂载，
      // 校验返回后必须自己发现身份已变并放弃写入。
      await page.evaluate((id: string) => {
        window.location.hash = `#/documents/${id}`
      }, secondId)
      await expect(page.getByRole('textbox', { name: '文档正文' })).toBeVisible()
      await focusEditor(page)
      await page.keyboard.insertText('第二份文档的正文')
      await expect.poll(() => editorText(page)).toBe('第二份文档的正文')

      release()
      // 切到别的文档后，面板会同时提示「备份属于另一个文档」和这次校验被放弃，
      // 这里只断言后者确实出现。
      await expect(
        page.locator('.backup-panel').getByText('当前文档或备份已改变，请重新确认导入。'),
      ).toBeVisible({ timeout: 20_000 })

      // 新文档必须保持干净：既没有多出段落，也没有被写入旧文档的备份。
      expect(await editorText(page)).toBe('第二份文档的正文')
      expect(await paragraphCount(page)).toBe(1)
    } finally {
      await closeAll(opened)
    }
  })

  test('连续换文件时，先选的那份不会覆盖后选的那份', async ({ browser, server }) => {
    const documentId = await server.createDocument()
    const context = await browser.newContext({ serviceWorkers: 'allow' })
    await slowDownLargeFileReads(context)
    const page = await context.newPage()
    await openAt(page, PRODUCTION_ORIGIN, documentId)

    try {
      // 甲文件接近上限，读取明显更慢；乙文件很小。
      const slowPath = writeBackupFile('慢.json', documentId, '这是甲备份', 7_500_000)
      const fastPath = writeBackupFile('快.json', documentId, '这是乙备份')

      await expect(page.getByRole('heading', { name: '备份与迁移' })).toBeVisible()

      // 用页面内同步派发两次 change，制造真实的交错：
      // 通过 setInputFiles 依次设置会因为 CDP 往返太慢而永远错开，测不到竞态。
      await dispatchTwoFileSelections(page, await readText(slowPath), await readText(fastPath), {
        firstName: '慢.json',
        secondName: '快.json',
      })

      // 最终必须停在乙：预览是乙的正文，文件名也是乙。
      await expect.poll(() => previewText(page), { timeout: 20_000 }).toBe('这是乙备份')
      await expect(page.locator('.backup-panel')).toContainText('快.json')

      // 再等一段时间，确认甲那次迟到的结果不会把预览改回去。
      await page.waitForTimeout(2500)
      expect(await previewText(page)).toBe('这是乙备份')
      await expect(page.locator('.backup-panel')).toContainText('快.json')
      await expect(page.locator('.backup-panel')).not.toContainText('这是甲备份')
    } finally {
      await context.close()
    }
  })

  test('清除选择后，仍在读取的文件结果不会回来', async ({ browser, server }) => {
    const documentId = await server.createDocument()
    const context = await browser.newContext({ serviceWorkers: 'allow' })
    await slowDownLargeFileReads(context)
    const page = await context.newPage()
    await openAt(page, PRODUCTION_ORIGIN, documentId)

    try {
      const slowPath = writeBackupFile('慢.json', documentId, '不该出现的正文', 7_500_000)
      await expect(page.getByRole('heading', { name: '备份与迁移' })).toBeVisible()

      await dispatchTwoFileSelections(page, await readText(slowPath), '', {
        firstName: '慢.json',
        secondName: '',
      })

      // 旧结果不得把预览或文件名带回来。
      await page.waitForTimeout(2500)
      await expect(page.getByRole('textbox', { name: '备份正文预览' })).toHaveCount(0)
      await expect(page.locator('.backup-panel')).not.toContainText('慢.json')
    } finally {
      await context.close()
    }
  })

  test('离线时仍可导出与预览，合并明确要求联网', async ({ browser, server }) => {
    const documentId = await server.createDocument()
    const opened = await openPages(browser, [{ origin: PRODUCTION_ORIGIN, documentId }])
    const [page] = opened.pages as [Page]

    try {
      await focusEditor(page)
      await page.keyboard.insertText('离线导出的内容')
      await expect.poll(() => editorText(page)).toBe('离线导出的内容')

      // 离线仍能导出：导出直接读实时文档，不发网络请求。
      await opened.contexts[0]!.setOffline(true)
      const backupPath = await exportBackup(page)
      expect(readFileSync(backupPath, 'utf8')).toContain('dom-collab-backup')

      // 离线仍可预览。
      await chooseBackup(page, backupPath)
      await expect.poll(() => previewText(page)).toBe('离线导出的内容')

      await merge(page)
      await expect(panelAlert(page)).toContainText('无法连接服务端', { timeout: 20_000 })

      // 断网时不能偷偷创建新文档，正文也保持原样。
      expect(await editorText(page)).toBe('离线导出的内容')
      expect(await paragraphCount(page)).toBe(1)
    } finally {
      await closeAll(opened)
    }
  })
})
