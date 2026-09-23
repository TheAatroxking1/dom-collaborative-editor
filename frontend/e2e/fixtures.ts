import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'

const backendDirectory = resolve(fileURLToPath(new URL('../../backend', import.meta.url)))
const pythonExecutable = join(backendDirectory, '.venv', 'Scripts', 'python.exe')

export const BACKEND_PORT = Number(process.env.COLLAB_E2E_BACKEND_PORT ?? 8791)
export const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`

const READY_POLL_INTERVAL_MS = 100
const READY_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 20_000

async function waitForHealth(origin: string, deadline: number): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok) return
    } catch {
      // 还没开始监听，继续轮询。
    }
    if (Date.now() > deadline) throw new Error(`后端未在预期时间内就绪：${origin}`)
    await new Promise((done) => setTimeout(done, READY_POLL_INTERVAL_MS))
  }
}

/**
 * 每个测试独立的后端进程，数据目录也是独立的。
 *
 * 通过 tests/uvicorn_launcher.py 启动：它允许从标准输入请求正常停止，
 * 这样才验证得了 lifespan 的收尾流程。强制结束（崩溃）场景直接 kill 进程。
 */
export class BackendProcess {
  readonly dataDirectory: string
  private child: ChildProcess | null = null

  private constructor(directory: string) {
    this.dataDirectory = directory
  }

  static async start(): Promise<BackendProcess> {
    const backend = new BackendProcess(mkdtempSync(join(tmpdir(), 'collab-e2e-')))
    await backend.spawn()
    return backend
  }

  /** 文档目录数据库。 */
  get directoryPath(): string {
    return join(this.dataDirectory, 'documents.sqlite3')
  }

  /** 库的 CRDT 存储数据库。 */
  get updatesPath(): string {
    return join(this.dataDirectory, 'updates.sqlite3')
  }

  private async spawn(): Promise<void> {
    const child = spawn(pythonExecutable, ['-m', 'tests.uvicorn_launcher'], {
      cwd: backendDirectory,
      env: {
        ...process.env,
        COLLAB_DATA_DIR: this.dataDirectory,
        COLLAB_PORT: String(BACKEND_PORT),
        PYTHONUTF8: '1',
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    this.child = child
    child.once('exit', () => {
      if (this.child === child) this.child = null
    })
    await waitForHealth(BACKEND_ORIGIN, Date.now() + READY_TIMEOUT_MS)
  }

  private async waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    return new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done(true)
      const timer = setTimeout(() => done(false), timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        done(true)
      })
    })
  }

  /** 请求正常停止并等待进程退出；返回 lifespan 是否走完了收尾流程。 */
  async stopGracefully(): Promise<boolean> {
    const child = this.child
    if (child === null) return true
    child.stdin?.write('stop\n')
    const exited = await this.waitForExit(child, SHUTDOWN_TIMEOUT_MS)
    if (exited) this.child = null
    return exited
  }

  /** 强制终止：只用于「崩溃」场景，不走应用清理流程。 */
  async kill(): Promise<void> {
    const child = this.child
    this.child = null
    if (child === null) return
    child.kill()
    await this.waitForExit(child, 10_000)
  }

  async restart(): Promise<void> {
    await this.kill()
    await this.spawn()
  }

  async stop(): Promise<void> {
    await this.kill()
    // 只清理自己创建、且确实位于临时根目录下的目录。
    const root = resolve(tmpdir())
    const target = resolve(this.dataDirectory)
    if (!target.startsWith(root) || !existsSync(target)) return
    try {
      rmSync(target, { recursive: true, force: true })
    } catch {
      // 刚被终止的进程可能还持有数据库文件句柄；临时目录由系统回收，
      // 清理失败不影响测试结论。
    }
  }

  /**
   * 破坏 CRDT 存储：把数据库文件的位置占成一个目录，store 无法打开，写入必然失败。
   *
   * 这是真实的存储故障，不需要往生产代码里插故障开关。
   */
  breakStorage(): void {
    const path = this.updatesPath
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${path}${suffix}`
      if (existsSync(sidecar)) rmSync(sidecar, { force: true })
    }
    mkdirSync(path, { recursive: true })
  }

  /** 复原存储：移除占位目录，让 store 在下次启动时重建数据库文件。 */
  restoreStorage(): void {
    const path = this.updatesPath
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
  }

  /** 用独立进程里的官方 store 读回正文，作为「确实写了」的证据。 */
  async readStoredText(documentId: string): Promise<string> {
    const script = `
import asyncio, sys
from pathlib import Path
from app.collaboration import read_document_state
from pycrdt import XmlFragment

async def main():
    document = await read_document_state(Path(sys.argv[1]), sys.argv[2])
    fragment = document.get("body", type=XmlFragment)
    print("".join(str(c) for c in fragment.children[0].children))

asyncio.run(main())
`
    const result = await new Promise<string>((done, fail) => {
      const reader = spawn(
        pythonExecutable,
        ['-c', script, this.updatesPath, documentId],
        { cwd: backendDirectory, env: { ...process.env, PYTHONUTF8: '1' } },
      )
      let out = ''
      let err = ''
      reader.stdout.on('data', (chunk) => (out += chunk))
      reader.stderr.on('data', (chunk) => (err += chunk))
      reader.once('error', fail)
      reader.once('exit', (code) =>
        code === 0 ? done(out.trim()) : fail(new Error(err || `读取失败：${code}`)),
      )
    })
    return result
  }

  async createDocument(): Promise<string> {
    const response = await fetch(`${BACKEND_ORIGIN}/api/documents`, { method: 'POST' })
    if (response.status !== 201) throw new Error(`创建文档失败：HTTP ${response.status}`)
    return ((await response.json()) as { documentId: string }).documentId
  }
}

export async function editorText(page: Page): Promise<string> {
  const paragraphs = page.getByRole('textbox', { name: '文档正文' }).locator('p')
  const texts = await paragraphs.allInnerTexts()
  return texts.map((text) => text.replace(/\n+$/, '')).join('\n')
}

export async function editorParagraphCount(page: Page): Promise<number> {
  return page.getByRole('textbox', { name: '文档正文' }).locator('p').count()
}

/**
 * 点击正文并等到它真的拿到焦点。
 *
 * 点击与焦点生效之间是异步的；不等这一步就发按键，事件会落到 body 上，
 * 编辑内核收不到，表现为「按了没反应」的随机失败。
 */
export async function focusEditor(page: Page): Promise<void> {
  await page.getByRole('textbox', { name: '文档正文' }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.getAttribute('aria-label') === '文档正文',
      ),
    )
    .toBe(true)
}

/**
 * 等待浏览器派发 selectionchange、编辑内核跟上 DOM 选区。
 *
 * 键盘扩展选区后 DOM 选区会立刻变化，但编辑内核要等 selectionchange 才更新它
 * 自己的 selection。这中间发出的删除键会按旧选区执行。
 */
export async function settleSelection(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 0))
      }),
  )
}

/** 用显式选区选中当前段落的开头若干字符。 */
export async function selectLeadingCharacters(page: Page, count: number): Promise<void> {
  await focusEditor(page)
  // 先确认光标真的回到段首再扩展：点击定位与 Home 生效之间是异步的，
  // 若此时就开始扩展，选区会从中途开始，长度永远到不了预期。
  const atParagraphStart = (): Promise<boolean> =>
    page.evaluate(() => window.getSelection()?.anchorOffset === 0)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.keyboard.press('Home')
    try {
      await expect.poll(atParagraphStart, { timeout: 2000 }).toBe(true)
      break
    } catch {
      // 再按一次 Home；仍不成功就交给下面的长度断言报错。
    }
  }
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Shift+ArrowRight')
  }
  const readSelection = (): Promise<string> =>
    page.evaluate(() => String(window.getSelection()?.toString()))
  await expect.poll(readSelection).toHaveLength(count)
  await settleSelection(page)
}

/**
 * 在编辑器里触发一次粘贴。
 *
 * 同时提供 text/html 时内容与 text/plain 不同，用来确认真的只取了纯文本。
 */
export async function pasteText(
  page: Page,
  plain: string,
  html = '<p>HTML内容</p><p>不该出现</p>',
): Promise<void> {
  await page.getByRole('textbox', { name: '文档正文' }).evaluate(
    (element, payload) => {
      const data = new DataTransfer()
      data.setData('text/plain', payload.plain)
      data.setData('text/html', payload.html)
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    },
    { plain, html },
  )
}

export async function openDocumentAt(page: Page, documentId: string): Promise<void> {
  await page.goto(`/#/documents/${documentId}`)
  await expect(page.getByRole('textbox', { name: '文档正文' })).toBeVisible()
}

export function connectionStatus(page: Page): Promise<string> {
  return page.getByRole('status').innerText()
}

export async function waitForConnected(page: Page): Promise<void> {
  await expect.poll(() => connectionStatus(page), { timeout: 20_000 }).toBe('已连接')
}

type Fixtures = {
  backend: BackendProcess
  firstContext: BrowserContext
  first: Page
  second: Page
  /** 与 first 同源同上下文的第二个标签页，共享本地存储。 */
  siblingTab: Page
  openDocument: (page: Page) => Promise<string>
}

export const test = base.extend<Fixtures>({
  backend: async ({}, use) => {
    const backend = await BackendProcess.start()
    try {
      await use(backend)
    } finally {
      await backend.stop()
    }
  },

  firstContext: async ({ browser, backend: _backend }, use) => {
    const context = await browser.newContext()
    try {
      await use(context)
    } finally {
      await context.close()
    }
  },

  first: async ({ firstContext }, use) => {
    const page = await firstContext.newPage()
    try {
      await use(page)
    } finally {
      await page.close()
    }
  },

  second: async ({ browser, backend: _backend }, use) => {
    // 独立上下文：与 first 不共享 IndexedDB，两端只能通过服务端同步。
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await use(page)
    } finally {
      await context.close()
    }
  },

  siblingTab: async ({ firstContext }, use) => {
    const page = await firstContext.newPage()
    try {
      await use(page)
    } finally {
      await page.close()
    }
  },

  openDocument: async ({ backend }, use) => {
    await use(async (page: Page) => {
      const documentId = await backend.createDocument()
      await openDocumentAt(page, documentId)
      return documentId
    })
  },
})

export { expect }
