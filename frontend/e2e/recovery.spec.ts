import type { Page } from '@playwright/test'

import {
  editorText as textOf,
  expect,
  focusEditor,
  openDocumentAt,
  selectLeadingCharacters,
  test,
  waitForConnected,
} from './fixtures'

type WebSocketControl = {
  block(): void
  allow(): void
}

/**
 * 只阻断 WebSocket，保留 HTTP：页面资源仍能加载，因此可以验证离线刷新。
 *
 * Playwright 的 unrouteAll 不覆盖 WebSocket 路由，所以这里装一个常驻处理器，
 * 用开关控制是否放行；放行时手动把两个方向的消息接起来。
 */
async function controlWebSocket(page: Page): Promise<WebSocketControl> {
  const state = { blocked: true }
  await page.routeWebSocket(/\/ws\/documents\//, (socket) => {
    if (state.blocked) {
      socket.close()
      return
    }
    const server = socket.connectToServer()
    socket.onMessage((message) => server.send(message))
    server.onMessage((message) => socket.send(message))
  })
  return {
    block: () => {
      state.blocked = true
    },
    allow: () => {
      state.blocked = false
    },
  }
}

/** 等到服务端确实有这段正文，作为「已经传出去了」的依据。 */
async function waitUntilStored(
  backend: { readStoredText: (id: string) => Promise<string> },
  documentId: string,
  expected: string,
): Promise<void> {
  await expect.poll(() => backend.readStoredText(documentId), { timeout: 20_000 }).toBe(expected)
}

test.describe('断线编辑与恢复', () => {
  test('两端断线期间各自编辑，重连后双方新增都保留', async ({
    backend,
    first,
    second,
    openDocument,
  }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)

    await focusEditor(first)
    await first.keyboard.insertText('共同起点')
    await expect.poll(() => textOf(second)).toBe('共同起点')
    await waitUntilStored(backend, documentId, '共同起点')

    // 两端同时离线。
    await backend.kill()

    await focusEditor(first)
    await first.keyboard.press('End')
    await first.keyboard.insertText('甲的补充')
    await focusEditor(second)
    await second.keyboard.press('Home')
    await second.keyboard.insertText('乙的补充')

    // 离线期间各自都能看到自己的修改。
    expect(await textOf(first)).toContain('甲的补充')
    expect(await textOf(second)).toContain('乙的补充')

    await backend.restart()
    await waitForConnected(first)
    await waitForConnected(second)

    await expect.poll(async () => (await textOf(first)) === (await textOf(second))).toBe(true)
    const merged = await textOf(first)
    expect(merged).toContain('甲的补充')
    expect(merged).toContain('乙的补充')
    expect(merged).toContain('共同起点')
  })

  test('断线期间只做删除，重连后删除仍然传播', async ({ backend, first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(second, documentId)

    await focusEditor(first)
    await first.keyboard.insertText('0123456789')
    await expect.poll(() => textOf(second)).toBe('0123456789')
    await waitUntilStored(backend, documentId, '0123456789')

    await backend.kill()

    // 只做删除：这是不推进状态向量的操作。
    await selectLeadingCharacters(first, 2)
    await first.keyboard.press('Delete')
    await expect.poll(() => textOf(first)).toBe('23456789')

    await backend.restart()
    await waitForConnected(first)

    // 另一端的删除也必须到达。
    await expect.poll(() => textOf(second)).toBe('23456789')
    await waitUntilStored(backend, documentId, '23456789')
  })

  test('后端完全断开时刷新，仍从本地缓存恢复正文', async ({ backend, first, openDocument }) => {
    const documentId = await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('断开前已缓存')
    await expect.poll(() => textOf(first)).toBe('断开前已缓存')
    await waitUntilStored(backend, documentId, '断开前已缓存')

    // 后端整个停掉：HTTP 与 WebSocket 都不可达。
    await backend.kill()
    await first.reload()

    // 缓存里有正文就必须显示出来。
    // 如果打开流程先做 HTTP 校验、失败即退出，这里会变成错误提示而不是编辑器。
    await expect(first.getByRole('textbox', { name: '文档正文' })).toBeVisible()
    await expect.poll(() => textOf(first)).toBe('断开前已缓存')

    // 断线期间还能继续编辑。
    await focusEditor(first)
    await first.keyboard.press('End')
    await first.keyboard.insertText('，断线期间追加')
    await expect.poll(() => textOf(first)).toBe('断开前已缓存，断线期间追加')

    // 后端回来后内容合并上去。
    await backend.restart()
    await waitForConnected(first)
    await expect
      .poll(() => backend.readStoredText(documentId), { timeout: 20_000 })
      .toBe('断开前已缓存，断线期间追加')
  })

  test('后端断开且本地没有缓存时，明确报错而不是空白页', async ({ backend, first }) => {
    const documentId = await backend.createDocument()
    await backend.kill()

    await first.goto(`/#/documents/${documentId}`)

    // 没有本地内容可恢复：必须给出可理解的提示，并且不挂载编辑器。
    await expect(first.getByText(/无法连接服务端/)).toBeVisible({ timeout: 20_000 })
    await expect(first.getByRole('textbox', { name: '文档正文' })).toHaveCount(0)
    await expect(first.getByRole('button', { name: '重试' })).toBeVisible()
  })

  test('只阻断 WebSocket 时刷新，正文从本地缓存恢复', async ({ backend, first, openDocument }) => {
    const documentId = await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('已经写进缓存')
    await expect.poll(() => textOf(first)).toBe('已经写进缓存')
    await waitUntilStored(backend, documentId, '已经写进缓存')

    // 只断 WS：页面资源仍由 Vite 提供，刷新可以完成。
    const sockets = await controlWebSocket(first)
    await first.reload()

    // 有缓存就能挂载编辑器并显示正文；没有缓存这里会是空等待。
    await expect(first.getByRole('textbox', { name: '文档正文' })).toBeVisible()
    await expect.poll(() => textOf(first)).toBe('已经写进缓存')

    sockets.allow()
    await first.reload()
    await waitForConnected(first)
    await expect.poll(() => textOf(first)).toBe('已经写进缓存')
  })
})

test.describe('服务重启与恢复', () => {
  test('正常停机后新浏览器上下文仍能读到内容', async ({ backend, first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('停机前的内容')
    await waitUntilStored(backend, documentId, '停机前的内容')

    // 关掉最后一个页面，再请求正常停止：lifespan 必须走完收尾流程。
    await first.close()
    const stopped = await backend.stopGracefully()
    // 必须真的以退出码 0 结束：只判「退出了没有」会把停机写盘失败也算成正常停止。
    // 失败时把服务端日志一起报出来，否则只能靠猜。
    expect(stopped.exited, `服务未在时限内退出；原始日志：\n${backend.logs}`).toBe(true)
    expect(stopped.code, `服务未正常停止；原始日志：\n${backend.logs}`).toBe(0)

    await backend.restart()

    // 全新上下文，没有任何本地缓存，内容只能来自数据库。
    await openDocumentAt(second, documentId)
    await expect.poll(() => textOf(second)).toBe('停机前的内容')
  })

  test('强制结束进程后新上下文仍能读到此前已写入的内容', async ({
    backend,
    first,
    second,
    openDocument,
  }) => {
    const documentId = await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('崩溃前已写入')
    await waitUntilStored(backend, documentId, '崩溃前已写入')

    // 强制结束：不走应用清理流程，也不依赖原浏览器补传。
    await first.close()
    await backend.kill()
    await backend.restart()

    await openDocumentAt(second, documentId)
    await expect.poll(() => textOf(second)).toBe('崩溃前已写入')
  })

  test('超过一百次更新之后重启，内容依然完整', async ({ backend, first, second, openDocument }) => {
    const documentId = await openDocument(first)
    await focusEditor(first)

    // SQLiteYStore 每 100 次更新做一次检查点，这里刻意越过这个边界。
    for (let index = 0; index < 120; index += 1) {
      await first.keyboard.insertText('x')
    }
    const expected = 'x'.repeat(120)
    await expect.poll(() => textOf(first), { timeout: 30_000 }).toBe(expected)
    await waitUntilStored(backend, documentId, expected)

    await first.close()
    await backend.kill()
    await backend.restart()

    await openDocumentAt(second, documentId)
    await expect.poll(() => textOf(second), { timeout: 30_000 }).toBe(expected)
  })
})

test.describe('存储与恢复失败', () => {
  test('存储不可用时创建文档返回错误，界面给出可操作提示', async ({ backend, first }) => {
    backend.breakStorage()

    await first.goto('/')
    await first.getByRole('button', { name: '新建文档' }).click()

    // 不能一直停在「正在打开」；要有明确提示而不是静默失败。
    await expect(first.getByText(/无法连接服务端|STORAGE_UNAVAILABLE/)).toBeVisible({
      timeout: 20_000,
    })
    // 也不应该跳到一个打不开的文档页面。
    await expect(first).not.toHaveURL(/#\/documents\//)
  })

  test('本地缓存不可用时明确报错，不无限等待', async ({ first, backend }) => {
    const documentId = await backend.createDocument()

    await first.addInitScript(() => {
      const original = indexedDB.open.bind(indexedDB)
      indexedDB.open = ((name: string, ...rest: unknown[]) => {
        if (String(name).startsWith('dom-collab-v2:')) {
          throw new DOMException('模拟缓存不可用', 'UnknownError')
        }
        return (original as (...args: unknown[]) => IDBOpenDBRequest)(name, ...rest)
      }) as typeof indexedDB.open
    })

    await first.goto(`/#/documents/${documentId}`)

    // 十秒上限内给出提示，并且提供重试入口。
    await expect(first.getByText(/本地内容恢复失败|本地内容恢复超时/)).toBeVisible({
      timeout: 20_000,
    })
    await expect(first.getByRole('button', { name: '重试' })).toBeVisible()
    // 正文没有被清空成「空文档」的假象：编辑器根本不该挂载。
    await expect(first.getByRole('textbox', { name: '文档正文' })).toHaveCount(0)
  })
})

test.describe('并发与隔离', () => {
  test('同源两个标签页各自编辑，不产生重复正文', async ({
    backend,
    first,
    siblingTab,
    openDocument,
  }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(siblingTab, documentId)

    await focusEditor(first)
    await first.keyboard.insertText('第一个标签页')
    await expect.poll(() => textOf(siblingTab)).toBe('第一个标签页')

    await focusEditor(siblingTab)
    await siblingTab.keyboard.press('End')
    await siblingTab.keyboard.insertText('，第二个标签页')
    await expect.poll(() => textOf(siblingTab)).toBe('第一个标签页，第二个标签页')
    await expect.poll(() => textOf(first)).toBe('第一个标签页，第二个标签页')

    // 刷新其中一个标签页后仍然只有一份正文。
    await first.reload()
    await expect.poll(() => textOf(first)).toBe('第一个标签页，第二个标签页')
    await waitUntilStored(backend, documentId, '第一个标签页，第二个标签页')
  })

  test('同源两个标签页的协作经过服务端而不是本地广播', async ({
    backend,
    first,
    siblingTab,
    openDocument,
  }) => {
    const documentId = await openDocument(first)
    await openDocumentAt(siblingTab, documentId)
    await waitForConnected(first)
    await waitForConnected(siblingTab)

    await focusEditor(siblingTab)
    await siblingTab.keyboard.insertText('必须经过 Python')
    await expect.poll(() => textOf(first)).toBe('必须经过 Python')

    // 服务端确实收到并保存了：这是「经过 Python」而不是跨标签页广播的证据。
    await waitUntilStored(backend, documentId, '必须经过 Python')
  })

  test('不同文档的更新互相隔离', async ({ backend, first, second, openDocument }) => {
    const leftId = await openDocument(first)
    await focusEditor(first)
    await first.keyboard.insertText('左文档')
    await waitUntilStored(backend, leftId, '左文档')

    const rightId = await openDocument(second)
    await focusEditor(second)
    await second.keyboard.insertText('右文档')
    await waitUntilStored(backend, rightId, '右文档')

    await expect.poll(() => backend.readStoredText(leftId)).toBe('左文档')
    await expect.poll(() => backend.readStoredText(rightId)).toBe('右文档')
  })
})
