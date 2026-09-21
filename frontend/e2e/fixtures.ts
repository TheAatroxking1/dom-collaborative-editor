import { test as base, expect, type Page } from '@playwright/test'

export type EditorFixtures = {
  /** 第一个独立浏览器上下文。 */
  first: Page
  /** 第二个独立浏览器上下文；与 first 不共享本地存储。 */
  second: Page
  openDocument: (page: Page) => Promise<string>
  editorText: (page: Page) => Promise<string>
}

/**
 * 两个独立 context：各自的 IndexedDB 与 WebSocket 会话，因此两者之间只能
 * 通过服务端同步，不会被同源本地存储或广播路径掩盖。
 */
export const test = base.extend<EditorFixtures>({
  first: async ({ browser }, use) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await use(page)
    await context.close()
  },

  second: async ({ browser }, use) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await use(page)
    await context.close()
  },

  openDocument: async ({ baseURL }, use) => {
    await use(async (page: Page) => {
      await page.goto(baseURL as string)
      await page.getByRole('button', { name: '新建文档' }).click()
      await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]{36}$/)
      const url = page.url()
      const documentId = url.slice(url.lastIndexOf('/') + 1)
      await expect(page.getByRole('textbox', { name: '文档正文' })).toBeVisible()
      return documentId
    })
  },

  editorText: async ({}, use) => {
    await use(async (page: Page) => {
      return page.getByRole('textbox', { name: '文档正文' }).innerText()
    })
  },
})

export { expect }
