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
import type { Editor } from '@tiptap/core'
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

/** 正常停止的结果。超时、非零退出与信号结束都要让用例失败，所以这里带上真实结果。 */
export type ShutdownResult = {
  exited: boolean
  code: number | null
  /** 被信号结束时是信号名；正常退出为 null。 */
  signal: NodeJS.Signals | null
}

/** 把退出异常整理成可读信息，并附上服务端原始日志。 */
function describeShutdownFailure(result: ShutdownResult, logs: string): string | null {
  if (!result.exited) {
    return `服务未在 ${SHUTDOWN_TIMEOUT_MS} ms 内正常退出；服务端原始日志：\n${logs}`
  }
  if (result.code !== 0) {
    const how =
      result.signal === null
        ? `退出码 ${String(result.code)}`
        : `被信号 ${result.signal} 结束`
    return `服务未正常停止（${how}，期望退出码 0）；服务端原始日志：\n${logs}`
  }
  return null
}

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
  /** 进程退出后记下的真实结果；null 表示还没有进程退出。 */
  private finished: { code: number | null; signal: NodeJS.Signals | null } | null = null
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
    child.once('exit', (code, signal) => {
      // 先记下真实结果再断开引用：stopGracefully 之后要靠它判断进程是不是
      // 早就自己退了，不能只看 child 是否为 null。
      this.finished = { code, signal }
      if (this.child === child) this.child = null
    })
    await waitForHealth(PRODUCTION_ORIGIN, Date.now() + READY_TIMEOUT_MS)
  }

  get logs(): string {
    return this.logLines.join('')
  }

  /**
   * 通过 stdin 请求正常停止，并等待进程退出。
   *
   * 返回真实退出结果而不是布尔值：正常停机必须是退出码 0，「超时」「非零退出」
   * 和「被信号结束」是三种不同的异常，调用方都要让用例失败，不能只打印日志。
   */
  async stopGracefully(): Promise<ShutdownResult> {
    const child = this.child
    if (child === null) {
      // 进程已经不在了（例如就绪之后自己崩了）。这里必须返回记下来的真实结果：
      // 凭空报「退出码 0」会把「提前退出」判成「正常停止」。
      const finished = this.finished
      if (finished === null) {
        // 连退出事件都没有记录到：宁可按失败处理，也不谎报成功。
        return { exited: true, code: null, signal: null }
      }
      return { exited: true, code: finished.code, signal: finished.signal }
    }
    child.stdin?.write('stop\n')
    const exited = await new Promise<boolean>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done(true)
      const timer = setTimeout(() => done(false), SHUTDOWN_TIMEOUT_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        done(true)
      })
    })
    // exitCode/signalCode 由 Node 在退出后填充，与记下的退出事件是同一份事实。
    const code = child.exitCode
    const signal = child.signalCode
    if (exited) this.child = null
    return { exited, code, signal }
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
  // 逐个段落取文本，并先移除协作者光标的装饰 DOM：访客名不是正文，
  // 用 allInnerTexts 会把它读进来，让同步断言出现假差异。
  // 段内的 <br> 是 HardBreak，按既有语义还原成换行。
  return paragraphs.evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const copy = node.cloneNode(true) as HTMLElement
        copy
          .querySelectorAll('.collaboration-carets__caret')
          .forEach((caret) => caret.remove())
        copy.querySelectorAll('br').forEach((br) => br.replaceWith('\n'))
        return (copy.textContent ?? '').replace(/\n+$/, '')
      })
      .join('\n'),
  )
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
 * 等浏览器派发 selectionchange，并确认编辑内核已经跟上 DOM 选区。
 *
 * 键盘扩展选区后 DOM 选区立刻变化，但编辑内核要等 selectionchange 才更新它自己的
 * selection。这中间发出的删除键会按旧选区执行，表现为「少删了几个字」。
 */
export async function settleSelection(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.getByRole('textbox', { name: '文档正文' }).evaluate((element) => {
        const selection = window.getSelection()
        if (!selection?.anchorNode || !selection.focusNode) return false
        if (!element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) {
          return false
        }
        const { view } = (element as HTMLElement & { editor: Editor }).editor
        return (
          view.state.selection.anchor === view.posAtDOM(selection.anchorNode, selection.anchorOffset) &&
          view.state.selection.head === view.posAtDOM(selection.focusNode, selection.focusOffset)
        )
      }),
    )
    .toBe(true)
}

/**
 * 选中当前段落开头的若干字符。
 *
 * 每次扩展都等编辑内核与 DOM 一致，再发下一次按键，最后确认精确长度。
 * 只在全部按键结束后等待太晚：中途 DOM 选区可能已经领先内核好几个字符。
 *
 * 还要先确认光标确实回到段首——点击定位与 Home 生效之间是异步的，若此时就开始
 * 扩展，选区会从中途开始，长度永远到不了预期。
 */
export async function selectLeadingCharacters(page: Page, count: number): Promise<void> {
  await focusEditor(page)
  const atParagraphStart = (): Promise<boolean> =>
    page.evaluate(() => window.getSelection()?.anchorOffset === 0)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.keyboard.press('Home')
    await settleSelection(page)
    try {
      await expect.poll(atParagraphStart, { timeout: 2000 }).toBe(true)
      break
    } catch {
      // 再按一次 Home；仍不成功就交给下面的长度断言报错。
    }
  }
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Shift+ArrowRight')
    await settleSelection(page)
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

    /** 停止服务并清理临时目录；返回退出异常的描述（正常为 null）。 */
    const shutdown = async (): Promise<string | null> => {
      const result = await server.stopGracefully()
      const failure = describeShutdownFailure(result, server.logs)
      if (!result.exited) await server.kill()
      server.cleanup()
      return failure
    }

    try {
      await use(server)
    } catch (error) {
      // 用例自身已经失败：退出异常只记录，不覆盖原始失败信息。
      const failure = await shutdown()
      if (failure !== null) {
        console.error(`[production] 服务退出异常（原用例已失败，不覆盖其错误）：${failure}`)
      }
      throw error
    }

    // 用例通过：此时退出异常必须让整个用例失败，而不是只打印一行日志。
    const failure = await shutdown()
    if (failure !== null) {
      throw new Error(`[production] ${failure}`)
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
