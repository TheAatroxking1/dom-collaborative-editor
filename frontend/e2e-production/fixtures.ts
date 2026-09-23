import { spawn, type ChildProcess } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'

/**
 * 生产构建版的端到端夹具。
 *
 * 与开发版套件的关键区别：这里跑的是真实构建产物（含 Service Worker），由真实
 * Python 进程通过同一个端口提供页面、API 与 WebSocket。开发套件拦截 WebSocket、
 * 用 Vite 提供页面，因此证明不了「整站断网后刷新还能打开页面」。
 */

const frontendDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const backendDirectory = resolve(frontendDirectory, '../backend')
const pythonExecutable = join(backendDirectory, '.venv', 'Scripts', 'python.exe')
const builtDirectory = join(frontendDirectory, 'dist')

export const PRODUCTION_PORT = Number(process.env.COLLAB_E2E_PRODUCTION_PORT ?? 5483)
export const PRODUCTION_ORIGIN = `http://127.0.0.1:${PRODUCTION_PORT}`

/**
 * 指向同一个服务的另一个 origin。
 *
 * 浏览器按 origin 隔离存储，`127.0.0.1` 与 `localhost` 是两份不同的本地存储，
 * 因此可以用一个服务进程验证「换地址后本地内容不会自动跟过去」。
 */
export const ALTERNATE_ORIGIN = `http://localhost:${PRODUCTION_PORT}`

/**
 * 版本 B 的标记，写在它的 index.html 里。
 *
 * 部署与断言共用这一个常量：测试要能证明「现在生效的是 B」，而不是只看提示消失。
 */
export const BUILD_B_MARKER = '<!-- build-b -->'

const READY_POLL_INTERVAL_MS = 100
const READY_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 20_000

async function waitForHealth(origin: string, deadline: number): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok) return
    } catch {
      // 还没开始监听。
    }
    if (Date.now() > deadline) throw new Error(`构建版服务未在预期时间内就绪：${origin}`)
    await new Promise((done) => setTimeout(done, READY_POLL_INTERVAL_MS))
  }
}

/** 构建版服务：一个 Python 进程同时提供页面、API 与 WebSocket。 */
export class ProductionServer {
  readonly dataDirectory: string
  readonly staticDirectory: string
  /** 版本 A 的哈希资源，切换版本 B 后仍需保留以便旧页面继续加载。 */
  private readonly keptAssetNames: string[] = []
  private child: ChildProcess | null = null
  private logLines: string[] = []

  private constructor(root: string) {
    this.dataDirectory = join(root, 'data')
    this.staticDirectory = join(root, 'static')
  }

  static async start(): Promise<ProductionServer> {
    if (!existsSync(join(builtDirectory, 'index.html'))) {
      throw new Error(
        `未找到构建产物：${builtDirectory}。请先运行 npm --prefix frontend run build。`,
      )
    }
    const server = new ProductionServer(mkdtempSync(join(tmpdir(), 'collab-prod-')))
    // 从真实构建产物复制一份工作副本：测试会切换版本，不能改动工作区。
    mkdirSync(server.staticDirectory, { recursive: true })
    cpSync(builtDirectory, server.staticDirectory, { recursive: true })
    await server.spawn()
    return server
  }

  private async spawn(): Promise<void> {
    const child = spawn(pythonExecutable, ['-m', 'tests.uvicorn_launcher'], {
      cwd: backendDirectory,
      env: {
        ...process.env,
        COLLAB_DATA_DIR: this.dataDirectory,
        COLLAB_STATIC_DIR: this.staticDirectory,
        COLLAB_PORT: String(PRODUCTION_PORT),
        PYTHONUTF8: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk: Buffer) => {
        this.logLines.push(chunk.toString('utf8'))
      })
    }
    child.once('exit', () => {
      if (this.child === child) this.child = null
    })
    await waitForHealth(PRODUCTION_ORIGIN, Date.now() + READY_TIMEOUT_MS)
  }

  get logs(): string {
    return this.logLines.join('')
  }

  /** 通过 stdin 请求正常停止；返回进程是否在时限内退出。 */
  async stopGracefully(): Promise<boolean> {
    const child = this.child
    if (child === null) return true
    child.stdin?.write('stop\n')
    const exited = await new Promise<boolean>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done(true)
      const timer = setTimeout(() => done(false), SHUTDOWN_TIMEOUT_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        done(true)
      })
    })
    if (exited) this.child = null
    return exited
  }

  async kill(): Promise<void> {
    const child = this.child
    this.child = null
    if (child === null) return
    child.kill()
    await new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done()
      child.once('exit', () => done())
    })
  }

  cleanup(): void {
    const root = resolve(tmpdir())
    const target = resolve(this.staticDirectory)
    if (!target.startsWith(root)) return
    // 失败时保留现场，便于排查。
    if (process.env.COLLAB_KEEP_PRODUCTION_ARTIFACTS === '1') return
    try {
      rmSync(resolve(this.dataDirectory, '..'), { recursive: true, force: true })
    } catch {
      // 刚结束的进程可能还持有文件句柄；临时目录由系统回收。
    }
  }

  async createDocument(): Promise<string> {
    const response = await fetch(`${PRODUCTION_ORIGIN}/api/documents`, { method: 'POST' })
    if (response.status !== 201) throw new Error(`创建文档失败：HTTP ${response.status}`)
    return ((await response.json()) as { documentId: string }).documentId
  }

  /**
   * 从文档目录里移除一条记录，用来制造「客户端有备份、服务端没有这份文档」。
   *
   * 只作用于测试自己的临时数据目录。这里借道 Python 的 sqlite3 而不是 Node 的
   * node:sqlite：后者要求 Node 22.5+（22.12 还需实验开关），而本项目文档允许
   * Node 20.19+；Python 本来就是硬依赖，不必因为它抬高 Node 版本要求。
   */
  async removeDocumentFromDirectory(documentId: string): Promise<void> {
    const script = `
import sqlite3, sys

connection = sqlite3.connect(sys.argv[1])
try:
    connection.execute("DELETE FROM documents WHERE id = ?", (sys.argv[2],))
    connection.commit()
finally:
    connection.close()
`
    await new Promise<void>((done, fail) => {
      const child = spawn(
        pythonExecutable,
        ['-c', script, join(this.dataDirectory, 'documents.sqlite3'), documentId],
        { cwd: backendDirectory, env: { ...process.env, PYTHONUTF8: '1' } },
      )
      let err = ''
      child.stderr.on('data', (chunk) => (err += chunk))
      child.once('error', fail)
      child.once('exit', (code) =>
        code === 0 ? done() : fail(new Error(err || `删除文档目录记录失败：${code}`)),
      )
    })
  }

  /**
   * 把「版本 B」放入正在服务的静态目录。
   *
   * 做法与真实发布一致：改出不同的 index.html，再用与 vite.config.ts 相同的
   * 预缓存规则重新生成 sw.js。保留版本 A 的哈希资源，否则已打开的旧页面会 404。
   */
  async deployVersionB(): Promise<void> {
    const indexPath = join(this.staticDirectory, 'index.html')
    if (this.keptAssetNames.length === 0) {
      const assets = join(this.staticDirectory, 'assets')
      this.keptAssetNames.push(...(existsSync(assets) ? listFiles(assets) : []))
    }

    // 版本 A 的产物先备份，用来生成 B 的清单后恢复：B 只改 index.html 的内容，
    // 资源文件名保持不变，因此旧页面的资源请求仍然可解析。
    const originalIndex = readFileSync(indexPath, 'utf8')
    writeFileSync(indexPath, `${originalIndex}\n${BUILD_B_MARKER}`, 'utf8')

    const { generateSW } = await import('workbox-build')
    // 用 workbox-build 自己的类型，不绕过检查：选项写错应该在类型阶段就暴露。
    const result = await generateSW({
      swDest: join(this.staticDirectory, 'sw.js'),
      globDirectory: this.staticDirectory,
      globPatterns: ['**/*.{html,js,css,svg,png,ico,woff2}'],
      navigateFallback: 'index.html',
      navigateFallbackAllowlist: [/^\/(?:index\.html)?(?:\?.*)?$/],
      runtimeCaching: [],
      cleanupOutdatedCaches: true,
      skipWaiting: false,
      clientsClaim: true,
    })
    if (result.warnings.length > 0) {
      throw new Error(`版本 B 的预缓存清单有警告：${result.warnings.join('；')}`)
    }
  }

  /** 版本 A 的哈希资源名，供断言「旧页面仍能加载资源」。 */
  assetsOfVersionA(): string[] {
    return [...this.keptAssetNames]
  }
}

function listFiles(directory: string): string[] {
  return readdirSync(directory)
}

export async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), {
      timeout: 20_000,
    })
    .toBe(true)
}

/**
 * 让页面看起来像 HTTP 局域网：安全上下文为 false。
 *
 * 127.0.0.1 在浏览器里算安全上下文，所以不这样做就测不到局域网那套降级。
 * 必须在页面导航之前调用。
 */
export async function simulateInsecureContext(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
  })
}

export async function editorText(page: Page): Promise<string> {
  const paragraphs = page.getByRole('textbox', { name: '文档正文' }).locator('p')
  const texts = await paragraphs.allInnerTexts()
  return texts.map((text) => text.replace(/\n+$/, '')).join('\n')
}

export async function focusEditor(page: Page): Promise<void> {
  await page.getByRole('textbox', { name: '文档正文' }).click()
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '文档正文'),
    )
    .toBe(true)
}

/**
 * 等浏览器派发 selectionchange、编辑内核跟上 DOM 选区。
 *
 * 键盘扩展选区后 DOM 选区立刻变化，但编辑内核要等 selectionchange 才更新它自己的
 * selection。这中间发出的删除键会按旧选区执行，表现为「少删了几个字」。
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
 * 选中当前段落开头的若干字符。
 *
 * 逐次扩展后确认选区长度真的到了预期值，再等编辑内核跟上，然后才返回：
 * 连续按键可能落在同一次 DOM 更新之前，直接删会少删或多删。
 */
export async function selectLeadingCharacters(page: Page, count: number): Promise<void> {
  await focusEditor(page)
  await page.keyboard.press('Home')
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Shift+ArrowRight')
  }
  await expect
    .poll(() =>
      page.evaluate(() => String(window.getSelection()?.toString()).length),
    )
    .toBe(count)
  await settleSelection(page)
}

export async function openDocumentAt(page: Page, documentId: string): Promise<void> {
  await page.goto(`${PRODUCTION_ORIGIN}/#/documents/${documentId}`)
  await expect(page.getByRole('textbox', { name: '文档正文' })).toBeVisible()
}

export async function waitForConnected(page: Page): Promise<void> {
  await expect
    .poll(() => page.getByRole('status').innerText(), { timeout: 20_000 })
    .toContain('已连接')
}

/** 只读检查 IndexedDB 里是否已有该文档的内容，作为「本地确实存过」的依据。 */
export async function hasLocalDocument(page: Page, documentId: string): Promise<boolean> {
  return page.evaluate(async (id: string) => {
    const databases = await indexedDB.databases()
    const name = `dom-collab-v2:${id}`
    if (!databases.some((entry) => entry.name === name)) return false
    return await new Promise<boolean>((done) => {
      const request = indexedDB.open(name)
      request.onerror = () => done(false)
      request.onsuccess = () => {
        const database = request.result
        const stores = Array.from(database.objectStoreNames)
        database.close()
        done(stores.length > 0)
      }
    })
  }, documentId)
}

type Fixtures = {
  server: ProductionServer
  context: BrowserContext
  page: Page
}

export const test = base.extend<Fixtures>({
  server: async ({}, use) => {
    const server = await ProductionServer.start()
    try {
      await use(server)
    } finally {
      // 正常停止，不用 kill：这样也能顺带验证 lifespan 收尾不会报错。
      const stopped = await server.stopGracefully()
      if (!stopped) {
        console.error('[production] 服务未在时限内正常退出，将强制结束')
        console.error(server.logs)
        await server.kill()
      }
      server.cleanup()
    }
  },

  context: async ({ browser }, use) => {
    // 生产离线测试必须允许 Service Worker 真正生效。
    const context = await browser.newContext({ serviceWorkers: 'allow' })
    try {
      await use(context)
    } finally {
      await context.close()
    }
  },

  page: async ({ context }, use) => {
    const page = await context.newPage()
    try {
      await use(page)
    } finally {
      await page.close()
    }
  },
})

export { expect }
export { readFileSync, writeFileSync, join, existsSync, mkdirSync, cpSync, tmpdir }
