import {
  editorText,
  expect,
  focusEditor,
  hasLocalDocument,
  openDocumentAt,
  PRODUCTION_ORIGIN,
  selectLeadingCharacters,
  test,
  waitForConnected,
  waitForServiceWorkerControl,
} from './fixtures'

/**
 * 整站离线刷新的真实验收。
 *
 * 关键是 context.setOffline(true) 之后**整页刷新**：只切断后端或拦截 WebSocket
 * 都不足以证明页面本身还能打开——那两种情况页面资源仍然来自网络。
 */

test.describe('页面外壳离线缓存', () => {
  test('断网后整页刷新，页面来自 Service Worker 且正文与离线修改都在', async ({
    server,
    context,
    page,
  }) => {
    const documentId = await server.createDocument()
    await openDocumentAt(page, documentId)
    await waitForConnected(page)

    await focusEditor(page)
    await page.keyboard.insertText('离线前正文')
    await expect.poll(() => editorText(page)).toBe('离线前正文')

    // 等本地确实写进去了再断网，否则这轮验证的是「没缓存」而不是「能离线」。
    await expect.poll(() => hasLocalDocument(page, documentId), { timeout: 20_000 }).toBe(true)

    await waitForServiceWorkerControl(page)
    await openDocumentAt(page, documentId)
    await focusEditor(page)
    await expect.poll(() => editorText(page)).toBe('离线前正文')

    // 整站断网。
    await context.setOffline(true)

    const response = await page.reload()
    expect(response?.fromServiceWorker()).toBe(true)
    await expect(page.getByRole('textbox', { name: '文档正文' })).toBeVisible()
    await expect.poll(() => editorText(page)).toBe('离线前正文')

    // 断网期间继续编辑。
    await focusEditor(page)
    await page.keyboard.press('End')
    await page.keyboard.insertText('，离线新增')
    await expect.poll(() => editorText(page)).toBe('离线前正文，离线新增')

    // 再次离线刷新：新增仍在。
    const second = await page.reload()
    expect(second?.fromServiceWorker()).toBe(true)
    await expect.poll(() => editorText(page)).toBe('离线前正文，离线新增')

    // 断网期间删除也要保留。删掉开头的「离线前正文，离线」共 8 个字符。
    await selectLeadingCharacters(page, 8)
    await page.keyboard.press('Delete')
    await expect.poll(() => editorText(page)).toBe('新增')

    await page.reload()
    await expect.poll(() => editorText(page)).toBe('新增')

    // 恢复网络后与另一端的编辑收敛。
    await context.setOffline(false)
    await waitForConnected(page)

    const other = await context.newPage()
    await other.goto(`${PRODUCTION_ORIGIN}/#/documents/${documentId}`)
    await focusEditor(other)
    await expect.poll(() => editorText(other), { timeout: 20_000 }).toBe('新增')
    await other.keyboard.press('End')
    await other.keyboard.insertText('来自另一端')
    await expect.poll(() => editorText(page), { timeout: 20_000 }).toBe('新增来自另一端')
    await other.close()
  })

  test('页面已缓存但没有该文档的正文时，离线打开不创建空编辑器', async ({
    server,
    context,
    page,
  }) => {
    // 先在同一个 context 里缓存页面外壳，但访问另一个文档。
    const cachedId = await server.createDocument()
    await openDocumentAt(page, cachedId)
    await waitForConnected(page)
    await waitForServiceWorkerControl(page)
    await expect.poll(() => hasLocalDocument(page, cachedId)).toBe(true)

    // 这个文档从未在本地址打开过，本地没有它的正文。
    const otherId = await server.createDocument()
    await context.setOffline(true)

    await page.goto(`${PRODUCTION_ORIGIN}/#/documents/${otherId}`)
    await page.reload()

    // 不能伪造一个空文档让用户以为打开成功了。
    await expect(page.getByRole('textbox', { name: '文档正文' })).toHaveCount(0)
    await expect(page.getByText(/无法连接服务端/)).toBeVisible({ timeout: 20_000 })
  })

  test('离线时接口请求失败，不会返回页面外壳', async ({ server, context, page }) => {
    const documentId = await server.createDocument()
    await openDocumentAt(page, documentId)
    await waitForServiceWorkerControl(page)
    await context.setOffline(true)

    const apiResponse = await page.evaluate(async () => {
      try {
        const response = await fetch('/api/documents', { method: 'POST' })
        return { ok: response.ok, status: response.status, text: (await response.text()).slice(0, 60) }
      } catch (error) {
        return { failed: true, message: String(error) }
      }
    })

    // 要么请求直接失败，要么明确不是 200；绝不能拿到 HTML 外壳。
    if ('failed' in apiResponse && apiResponse.failed) {
      expect(apiResponse.failed).toBe(true)
    } else {
      expect(apiResponse.ok).toBe(false)
      expect(apiResponse.text ?? '').not.toContain('<div id="app">')
    }
  })

  test('缓存里没有 API 与 WebSocket 响应', async ({ server, page }) => {
    const documentId = await server.createDocument()
    await openDocumentAt(page, documentId)
    await waitForConnected(page)
    await waitForServiceWorkerControl(page)

    const cachedUrls = await page.evaluate(async () => {
      const names = await caches.keys()
      const urls: string[] = []
      for (const name of names) {
        const cache = await caches.open(name)
        for (const request of await cache.keys()) urls.push(request.url)
      }
      return urls
    })

    expect(cachedUrls.length).toBeGreaterThan(0)
    expect(cachedUrls.filter((url) => url.includes('/api/'))).toEqual([])
    expect(cachedUrls.filter((url) => url.includes('/ws/'))).toEqual([])
  })

  test('全新上下文从未访问时，离线首次访问不声称可用', async ({ browser, server }) => {
    // 这个 context 从未访问过站点，缓存与本地正文都不存在。
    const fresh = await browser.newContext({ serviceWorkers: 'allow' })
    const page = await fresh.newPage()
    try {
      const documentId = await server.createDocument()
      await fresh.setOffline(true)

      await page.goto(`${PRODUCTION_ORIGIN}/#/documents/${documentId}`).catch(() => undefined)
      // 离线且无缓存时，页面根本加载不出来——这正是「首次访问必须联网」的含义。
      const hasApp = await page
        .getByRole('button', { name: '新建文档' })
        .isVisible()
        .catch(() => false)
      expect(hasApp).toBe(false)
    } finally {
      await fresh.close()
    }
  })
})

test.describe('版本更新不打断编辑', () => {
  test('两个编辑页遇到新版本都不自动刷新，关闭全部页面后可更新', async ({ server, context, browser }) => {
    const documentId = await server.createDocument()

    const first = await context.newPage()
    const second = await context.newPage()
    await first.goto(`${PRODUCTION_ORIGIN}/#/documents/${documentId}`)
    await second.goto(`${PRODUCTION_ORIGIN}/#/documents/${documentId}`)
    await waitForServiceWorkerControl(first)
    await second.reload()

    await focusEditor(first)
    await first.keyboard.insertText('编辑中内容')
    await expect.poll(() => editorText(first)).toBe('编辑中内容')

    // 部署版本 B：index.html 变了，预缓存清单随之变化。
    await server.deployVersionB()

    // 主动触发更新检查；两页都应检测到新版本。
    await Promise.all(
      [first, second].map((page) =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration()
          await registration?.update()
        }),
      ),
    )

    // 两页都必须显示版本提示，并且不能自动刷新（正文与选区都还在）。
    await expect(first.getByText(/新版本已准备好/)).toBeVisible({ timeout: 20_000 })
    await expect(second.getByText(/新版本已准备好/)).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => editorText(first)).toBe('编辑中内容')
    await expect.poll(() => editorText(second)).toBe('编辑中内容')
    await first.keyboard.insertText('仍在编辑')
    await expect.poll(() => editorText(first)).toBe('编辑中内容仍在编辑')

    // 关闭全部应用页面但不销毁 context，重新打开：此时新版本生效。
    await first.close()
    await second.close()

    const reopened = await context.newPage()
    await reopened.goto(`${PRODUCTION_ORIGIN}/#/documents/${documentId}`)
    await expect(reopened.getByRole('textbox', { name: '文档正文' })).toBeVisible()
    await expect.poll(() => editorText(reopened), { timeout: 20_000 }).toBe('编辑中内容仍在编辑')

    // 版本提示在重开后消失，说明确实换到了新版本。
    await expect(reopened.getByText(/新版本已准备好/)).toHaveCount(0)
    await reopened.close()
  })

  test('重开后正文来自本地缓存而不是旧页面', async ({ server, context }) => {
    const documentId = await server.createDocument()
    const page = await context.newPage()
    await page.goto(`${PRODUCTION_ORIGIN}/#/documents/${documentId}`)
    await waitForServiceWorkerControl(page)
    await focusEditor(page)
    await page.keyboard.insertText('本地保留的正文')
    await expect.poll(() => hasLocalDocument(page, documentId), { timeout: 20_000 }).toBe(true)

    await page.close()

    // 全新页面：正文必须来自 IndexedDB，而不是上一个页面残留的状态。
    const reopened = await context.newPage()
    await reopened.goto(`${PRODUCTION_ORIGIN}/#/documents/${documentId}`)
    await expect.poll(() => editorText(reopened), { timeout: 20_000 }).toBe('本地保留的正文')
    await reopened.close()
  })
})
