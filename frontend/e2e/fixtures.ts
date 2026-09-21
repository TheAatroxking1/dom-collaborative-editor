import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { test as base, expect, type Page } from '@playwright/test'

const backendDirectory = resolve(fileURLToPath(new URL('../../backend', import.meta.url)))
const pythonExecutable = join(backendDirectory, '.venv', 'Scripts', 'python.exe')

export const BACKEND_PORT = Number(process.env.COLLAB_E2E_BACKEND_PORT ?? 8791)
export const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`

/** 就绪探测的轮询节奏与上限，避免用固定 sleep 猜启动时间。 */
const READY_POLL_INTERVAL_MS = 100
const READY_TIMEOUT_MS = 30_000

async function waitForHealth(origin: string, deadline: number): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok) return
    } catch {
      // 进程还没开始监听，继续轮询。
    }
    if (Date.now() > deadline) throw new Error(`后端未在预期时间内就绪：${origin}`)
    await new Promise((done) => setTimeout(done, READY_POLL_INTERVAL_MS))
  }
}

/** 每个测试独立的后端进程，数据库位于自己的临时目录。 */
export class BackendProcess {
  readonly databaseDirectory: string
  readonly databasePath: string
  readonly controlToken = randomUUID()
  private child: ChildProcess | null = null

  private constructor(directory: string) {
    this.databaseDirectory = directory
    this.databasePath = join(directory, 'collab.db')
  }

  static async start(): Promise<BackendProcess> {
    const directory = mkdtempSync(join(tmpdir(), 'collab-e2e-'))
    const backend = new BackendProcess(directory)
    await backend.spawn()
    return backend
  }

  private async spawn(): Promise<void> {
    const child = spawn(
      pythonExecutable,
      ['-m', 'tests.e2e_server'],
      {
        cwd: backendDirectory,
        env: {
          ...process.env,
          COLLAB_DB_PATH: this.databasePath,
          COLLAB_PORT: String(BACKEND_PORT),
          COLLAB_CONTROL_TOKEN: this.controlToken,
          PYTHONUTF8: '1',
        },
        stdio: 'ignore',
      },
    )
    this.child = child
    child.once('exit', () => {
      if (this.child === child) this.child = null
    })
    await waitForHealth(BACKEND_ORIGIN, Date.now() + READY_TIMEOUT_MS)
  }

  /** 终止进程而不是走应用清理流程：崩溃恢复必须靠持久化日志。 */
  async kill(): Promise<void> {
    const child = this.child
    this.child = null
    if (child === null) return
    child.kill()
    await new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        done()
        return
      }
      child.once('exit', () => done())
    })
  }

  async restart(): Promise<void> {
    await this.kill()
    await this.spawn()
  }

  async stop(): Promise<void> {
    await this.kill()
    // 只清理自己创建、且确实位于临时根目录下的目录。
    const root = resolve(tmpdir())
    const target = resolve(this.databaseDirectory)
    if (!target.startsWith(root) || !existsSync(target)) return
    try {
      rmSync(target, { recursive: true, force: true })
    } catch {
      // 刚被终止的进程在 Windows 上可能还持有数据库文件句柄，清理失败不影响
      // 测试结论；临时目录由操作系统回收，不该因此判定用例失败。
    }
  }

  get gates(): GateClient {
    return new GateClient(BACKEND_ORIGIN, this.controlToken)
  }

  get origin(): string {
    return BACKEND_ORIGIN
  }

  createDocument(): Promise<string> {
    return createDocument(BACKEND_ORIGIN)
  }
}

export type GateMatch = {
  documentId?: string
  txId?: string
  syncId?: string
}

export type GatePoint = 'after_commit' | 'before_sync_send' | 'before_ack_send'

/** 控制接口客户端：让真实提交与发送路径在指定位置暂停。 */
export class GateClient {
  constructor(
    private readonly origin: string,
    private readonly token: string,
  ) {}

  private async call(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-control-token': this.token },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`控制接口失败 ${path}：HTTP ${response.status} ${await response.text()}`)
    }
    return response.json()
  }

  async arm(point: GatePoint, match: GateMatch = {}): Promise<string> {
    const result = (await this.call('/control/gates', { point, ...match })) as {
      gateId: string
    }
    return result.gateId
  }

  async wait(gateId: string): Promise<void> {
    await this.call(`/control/gates/${gateId}/wait`, {})
  }

  async release(gateId: string): Promise<void> {
    await this.call(`/control/gates/${gateId}/release`, {})
  }

  async releaseAll(): Promise<void> {
    await this.call('/control/gates/release-all', {})
  }
}

export async function createDocument(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/documents`, { method: 'POST' })
  if (!response.ok) throw new Error(`创建文档失败：HTTP ${response.status}`)
  const payload = (await response.json()) as { documentId: string }
  return payload.documentId
}

/** 用独立连接直接读数据库，验证的是真正落盘的内容而不是服务端内存状态。 */
export function readSqlite<T>(databasePath: string, query: string, params: unknown[]): T[] {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return database.prepare(query).all(...(params as never[])) as T[]
  } finally {
    database.close()
  }
}

export function countUpdates(databasePath: string, documentId: string, txId?: string): number {
  const rows = readSqlite<{ total: number }>(
    databasePath,
    txId === undefined
      ? 'SELECT COUNT(*) AS total FROM updates WHERE document_id = ?'
      : 'SELECT COUNT(*) AS total FROM updates WHERE document_id = ? AND tx_id = ?',
    txId === undefined ? [documentId] : [documentId, txId],
  )
  return rows[0]?.total ?? 0
}

export type UpdateRow = { tx_id: string; seq: number; payload_sha256: string }

export function readUpdates(databasePath: string, documentId: string): UpdateRow[] {
  return readSqlite<UpdateRow>(
    databasePath,
    'SELECT tx_id, seq, payload_sha256 FROM updates WHERE document_id = ? ORDER BY seq ASC',
    [documentId],
  )
}

export function documentIdFromUrl(page: Page): string {
  const url = page.url()
  const marker = '#/documents/'
  const index = url.indexOf(marker)
  if (index < 0) throw new Error(`地址中不含文档标识：${url}`)
  return url.slice(index + marker.length)
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
 * 键盘扩展选区后，DOM 选区会立刻变化，但编辑内核要等 selectionchange 才更新它
 * 自己的 selection。这中间发出的删除键会按旧选区执行，表现为「按了没反应」。
 */
export async function settleSelection(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 0))
      }),
  )
}

/**
 * 用显式选区选中当前段落的开头若干字符。
 *
 * 先确认选区真的建立起来了再返回，避免后续删除落在一个尚未扩展的选区上。
 */
export async function selectLeadingCharacters(page: Page, count: number): Promise<void> {
  await focusEditor(page)
  await page.keyboard.press('Home')
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Shift+ArrowRight')
  }
  const readSelection = (): Promise<string> =>
    page.evaluate(() => String(window.getSelection()?.toString()))
  await expect.poll(readSelection).toHaveLength(count)
  await settleSelection(page)
}

export async function openDocumentAt(page: Page, documentId: string): Promise<void> {
  await page.goto(`/#/documents/${documentId}`)
  await expect(page.getByRole('textbox', { name: '文档正文' })).toBeVisible()
}

export async function saveStatus(page: Page): Promise<string> {
  return page.getByRole('status').innerText()
}

type Fixtures = {
  backend: BackendProcess
  firstContext: import('@playwright/test').BrowserContext
  first: Page
  second: Page
  /** 与 first 同源同上下文的第二个标签页，共享本地存储。 */
  siblingTab: Page
  openDocument: (page: Page) => Promise<string>
}

/**
 * 后端进程与浏览器上下文都由夹具管理：每个测试拿到独立数据库和独立进程，
 * 因此故障注入不会泄漏到其他测试，也不会被上一轮的残留状态掩盖。
 */
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
