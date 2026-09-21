import { DatabaseSync } from 'node:sqlite'
import type { Page } from '@playwright/test'

import {
  countUpdates,
  editorText as textOf,
  expect,
  focusEditor,
  openDocumentAt,
  readUpdates,
  saveStatus,
  test,
} from './fixtures'

/** 直接改数据库文件的写锁，用来制造真实的提交失败。 */
class SqliteWriteLock {
  private database: DatabaseSync | null = null

  constructor(private readonly databasePath: string) {}

  open(): void {
    this.database = new DatabaseSync(this.databasePath)
    this.database.exec('PRAGMA busy_timeout = 0')
    this.database.exec('BEGIN IMMEDIATE')
  }

  close(): void {
    if (this.database === null) return
    try {
      this.database.exec('ROLLBACK')
    } catch {
      // 锁已经被释放时无需处理。
    }
    this.database.close()
    this.database = null
  }
}

async function typeText(page: Page, text: string): Promise<void> {
  await focusEditor(page)
  await page.keyboard.insertText(text)
}

/** 用显式选区选中开头若干字符，避免点击落点带来的位置差异。 */
async function selectLeadingCharacters(page: Page, count: number): Promise<void> {
  await focusEditor(page)
  await page.keyboard.press('Home')
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Shift+ArrowRight')
  }
  await expect
    .poll(() => page.evaluate(() => String(window.getSelection()?.toString())))
    .toHaveLength(count)
}

/** 等待界面稳定显示服务端已保存。 */
async function waitForServerSaved(page: Page, timeout = 30_000): Promise<void> {
  await expect.poll(() => saveStatus(page), { timeout }).toBe('服务端已保存')
}

test.describe('ACK 丢失与崩溃窗口', () => {
  test('ACK 丢失后按原 txId 重发，不重复记录也不重复插字', async ({
    backend,
    first,
    openDocument,
  }) => {
    const documentId = await openDocument(first)
    await typeText(first, '第一次输入')
    await waitForServerSaved(first)

    // 让这次提交的确认停在发送路径上：服务端已经落盘，客户端还没收到 ACK。
    const gateId = await backend.gates.arm('before_ack_send', { documentId })
    await typeText(first, '第二次输入')
    await backend.gates.wait(gateId)

    // 关键窗口：确认还没送达，但记录已经真正提交。
    const committed = readUpdates(backend.databasePath, documentId)
    const committedTxId = committed[committed.length - 1]?.tx_id as string
    expect(countUpdates(backend.databasePath, documentId, committedTxId)).toBe(1)

    // ACK 永远不会送达：直接终止进程，客户端只能靠重连与重发恢复。
    await backend.kill()
    await backend.restart()
    await waitForServerSaved(first)

    // 重连会重新握手并产生新的补同步事务，但同一 txId 永远只有一条记录。
    expect(countUpdates(backend.databasePath, documentId, committedTxId)).toBe(1)
    const replayed = readUpdates(backend.databasePath, documentId).filter(
      (row) => row.tx_id === committedTxId,
    )
    expect(replayed).toHaveLength(1)
    expect(await textOf(first)).toBe('第一次输入第二次输入')
  })

  test('提交后、广播前崩溃，重启后新客户端能读到已落盘内容', async ({
    backend,
    first,
    second,
    openDocument,
  }) => {
    const documentId = await openDocument(first)
    await typeText(first, '崩溃前')
    await waitForServerSaved(first)

    // after_commit 在房间锁内：暂停在这里就等于「已落盘但还没广播」的崩溃窗口。
    const gateId = await backend.gates.arm('after_commit', { documentId })
    await typeText(first, '已提交未广播')
    await backend.gates.wait(gateId)

    // 此刻内容已经在 SQLite 里，但任何客户端都还没看到它。
    const committed = readUpdates(backend.databasePath, documentId)
    const committedTxId = committed[committed.length - 1]?.tx_id as string
    expect(countUpdates(backend.databasePath, documentId, committedTxId)).toBe(1)

    await backend.kill()
    await backend.restart()

    // 全新浏览器直接读文档：恢复不依赖原浏览器是否补传。
    await openDocumentAt(second, documentId)
    await expect.poll(() => textOf(second)).toBe('崩溃前已提交未广播')

    // 原客户端重连后重试同一事务，仍然只有一条记录，文字也没有重复。
    await waitForServerSaved(first)
    expect(countUpdates(backend.databasePath, documentId, committedTxId)).toBe(1)
    await expect.poll(() => textOf(first)).toBe('崩溃前已提交未广播')
    await expect.poll(() => textOf(second)).toBe('崩溃前已提交未广播')
  })
})

test.describe('握手与断线', () => {
  test('握手期间另一端持续提交，恢复后不丢更新', async ({
    backend,
    first,
    second,
    openDocument,
  }) => {
    const documentId = await openDocument(first)
    await typeText(first, '起始内容')
    await waitForServerSaved(first)

    // 暂停第二端的同步响应；此时第一端继续提交，第二端尚未登记完初始差量。
    const gateId = await backend.gates.arm('before_sync_send', { documentId })
    const navigating = second.goto(`/#/documents/${documentId}`)
    await backend.gates.wait(gateId)

    for (const chunk of ['甲', '乙', '丙']) {
      await focusEditor(first)
      await first.keyboard.press('End')
      await first.keyboard.insertText(chunk)
      await waitForServerSaved(first)
    }

    await backend.gates.release(gateId)
    await navigating

    // 第二端既拿到同步差量，也拿到握手期间的广播，内容必须完整。
    await expect.poll(() => textOf(second)).toBe('起始内容甲乙丙')
    await expect.poll(() => textOf(first)).toBe('起始内容甲乙丙')
  })

  test('离线删除在重连后传播，不依赖插入来掩盖', async ({ backend, first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await typeText(first, '0123456789')
    await waitForServerSaved(first)

    await backend.kill()

    // 断线期间只做删除：这是状态向量不会推进的操作。
    await selectLeadingCharacters(first, 2)
    await first.keyboard.press('Delete')
    await expect.poll(() => textOf(first)).toBe('23456789')

    await backend.restart()
    await waitForServerSaved(first)

    // 全新客户端读到的就是删除后的内容，说明删除确实跨过了服务端。
    await openDocumentAt(second, documentId)
    await expect.poll(() => textOf(second)).toBe('23456789')
  })

  test('刷新后先从本地恢复，重连后再与服务端合并', async ({ backend, first, openDocument }) => {
    const documentId = await openDocument(first)
    await typeText(first, '刷新前已落盘')
    await waitForServerSaved(first)

    await backend.kill()
    await first.reload()

    // 页面资源由 Vite 提供，仍然可以加载；正文来自 IndexedDB。
    await expect(first.getByRole('textbox', { name: '文档正文' })).toBeVisible()
    await expect.poll(() => textOf(first)).toBe('刷新前已落盘')

    await backend.restart()
    await waitForServerSaved(first)
    await expect.poll(() => textOf(first)).toBe('刷新前已落盘')

    // 联网状态下再刷新一次：本地日志既有已确认记录也有服务端广播，
    // 重放它们不能把正文变成两份。
    const rowsBeforeSecondReload = readUpdates(backend.databasePath, documentId).length
    await first.reload()
    await expect.poll(() => textOf(first)).toBe('刷新前已落盘')
    await waitForServerSaved(first)
    await expect.poll(() => textOf(first)).toBe('刷新前已落盘')
    expect(readUpdates(backend.databasePath, documentId).length).toBeGreaterThanOrEqual(
      rowsBeforeSecondReload,
    )
  })
})

test.describe('存储故障', () => {
  test('服务端写锁导致保存失败时如实报告，释放后恢复', async ({ backend, first, openDocument }) => {
    await openDocument(first)
    await typeText(first, '第一段已保存')
    await waitForServerSaved(first)

    const lock = new SqliteWriteLock(backend.databasePath)
    lock.open()
    try {
      await typeText(first, '写锁期间')
      await expect(first.getByText('服务端保存失败', { exact: true })).toBeVisible()

      // 失败不等于丢弃：内容仍在编辑器里，本地也仍然保留。
      await expect.poll(() => textOf(first)).toBe('第一段已保存写锁期间')
    } finally {
      lock.close()
    }

    await first.getByRole('button', { name: '重试' }).click()
    await waitForServerSaved(first)
    await expect.poll(() => textOf(first)).toBe('第一段已保存写锁期间')
  })

  test('本地写入失败时保留内容并明确报错，恢复后补写', async ({ first, openDocument }) => {
    await first.addInitScript(() => {
      const original = IDBObjectStore.prototype.add
      const state = { fail: false }
      Object.defineProperty(window, '__collabFailLocalWrites', {
        get: () => state.fail,
        set: (value: boolean) => {
          state.fail = value
        },
      })
      IDBObjectStore.prototype.add = function patched(this: IDBObjectStore, ...args: unknown[]) {
        if ((window as unknown as { __collabFailLocalWrites: boolean }).__collabFailLocalWrites) {
          // 在原生 API 层失败：事务会被中止，日志的 completed() 会拒绝。
          throw new DOMException('模拟本地写入失败', 'UnknownError')
        }
        return (original as (...rest: unknown[]) => IDBRequest).apply(this, args)
      }
    })

    await openDocument(first)
    await typeText(first, '本地写不进去')

    await first.evaluate(() => {
      ;(window as unknown as { __collabFailLocalWrites: boolean }).__collabFailLocalWrites = true
    })
    await typeText(first, '这段会失败')
    await expect(first.getByText('本地保存失败', { exact: true })).toBeVisible()
    // 内存中的内容不能被清空。
    await expect.poll(() => textOf(first)).toContain('这段会失败')

    await first.evaluate(() => {
      ;(window as unknown as { __collabFailLocalWrites: boolean }).__collabFailLocalWrites = false
    })
    await first.getByRole('button', { name: '重试' }).click()
    await waitForServerSaved(first)
    await expect.poll(() => textOf(first)).toContain('这段会失败')
  })
})

test.describe('并发与隔离', () => {
  test('两端各自暂停上行后在相同位置插入，双方新增都保留', async ({
    backend,
    first,
    second,
    openDocument,
  }) => {
    const documentId = await openDocument(first)
    await typeText(first, 'AB')
    await waitForServerSaved(first)

    await openDocumentAt(second, documentId)
    await expect.poll(() => textOf(second)).toBe('AB')

    // 同时阻断两端的确认发送，让两次插入真正并发到达服务端。
    const firstGate = await backend.gates.arm('before_ack_send', { documentId })
    const secondGate = await backend.gates.arm('before_ack_send', { documentId })

    await focusEditor(first)
    await first.keyboard.press('End')
    await first.keyboard.press('ArrowLeft')
    await first.keyboard.insertText('甲')

    await focusEditor(second)
    await second.keyboard.press('End')
    await second.keyboard.press('ArrowLeft')
    await second.keyboard.insertText('乙')

    await backend.gates.wait(firstGate)
    await backend.gates.wait(secondGate)
    await backend.gates.releaseAll()

    await waitForServerSaved(first, 40_000)
    await waitForServerSaved(second, 40_000)

    await expect.poll(async () => (await textOf(first)) === (await textOf(second))).toBe(true)
    const merged = await textOf(first)
    expect(merged).toHaveLength(4)
    expect(merged).toContain('甲')
    expect(merged).toContain('乙')
    expect(merged).toContain('A')
    expect(merged).toContain('B')
  })

  test('同源两个标签页各自编辑，不产生重复正文', async ({
    first,
    siblingTab,
    openDocument,
  }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(siblingTab, documentId)

    await typeText(first, '第一个标签页')
    await expect.poll(() => textOf(siblingTab)).toBe('第一个标签页')

    await focusEditor(siblingTab)
    await siblingTab.keyboard.press('End')
    await siblingTab.keyboard.insertText('，第二个标签页')
    await expect.poll(() => textOf(siblingTab)).toBe('第一个标签页，第二个标签页')
    await expect.poll(() => textOf(first)).toBe('第一个标签页，第二个标签页')

    // 刷新其中一个标签页后仍然只有一份正文。
    await first.reload()
    await expect.poll(() => textOf(first)).toBe('第一个标签页，第二个标签页')
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('离开文档后不再有新记录写入', async ({ backend, first, openDocument }) => {
    const documentId = await openDocument(first)
    await typeText(first, '离开前')
    await waitForServerSaved(first)

    const before = readUpdates(backend.databasePath, documentId).length
    await first.goto('/')
    await expect(first.getByRole('button', { name: '新建文档' })).toBeVisible()
    await first.waitForTimeout(1000)

    expect(readUpdates(backend.databasePath, documentId).length).toBe(before)
  })
})
