# Offline and LAN Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已指定交给 Claude 实现；没有这些技能时按本文顺序执行即可，不为安装技能阻塞工作。

**Goal:** 修复完整离线刷新、改变访问地址后迁移正文、HTTP 局域网复制失败三个边界，交付可公开的源码及本地/局域网运行指南。

**Architecture:** 用生成式 Service Worker 缓存页面资源，正文仍由现有 Yjs 库栈保存和同步。FastAPI 可选提供生产静态资源；文件备份仅将完整 Yjs update 合并回原 documentId；复制失败显示手动复制字段。

**Tech Stack:** 保留 Vue 3.5.43、Tiptap 3.31.3、Yjs 13.6.32、y-websocket 3.1.0、y-indexeddb 9.0.12、Vite 8.3.0、Python 3.12、FastAPI、pycrdt-websocket/pycrdt-store；仅新增直接开发依赖 vite-plugin-pwa 1.3.0。

## Global Constraints

- UTF-8；一个 Uvicorn worker；保留 Vue/Tiptap/Yjs 与 FastAPI/pycrdt 库组合。
- 正文继续仅由 Yjs、y-websocket、y-indexeddb、pycrdt-store 处理；不新增 ACK、事务队列、重放日志、正文 HTTP 保存接口。
- 保留 `body` 根、现有 paragraph/text/hardBreak schema、`dom-collab-v2:` 缓存前缀、现有 SQLite 数据。
- `connected`、`synced` 和页面缓存完成都不表示正文已持久化到服务器。
- 页面只部署在域名/地址根路径；不增加子路径、GitHub Pages 或公网部署方案。
- 不手动清除用户文档缓存或数据库；允许 Workbox 正常淘汰旧版静态资源缓存。不升级无关依赖，不修改现有粘贴、中文输入和撤销重做行为。
- GitHub 交付是源码及说明；不执行推送，不自动配置证书信任、防火墙或公网端口。

设计及 B1–B10 验收定义见 [设计文档](../specs/2026-09-23-offline-lan-portability-design.md)。本文件为计划，所有任务尚未执行。实现可以小幅调整组件名称，不能自行扩大业务范围或放宽验收。

## 0. 起点、文件职责与执行顺序

当前实现目录：`F:\基于DOM的协作编辑器\.claude\worktrees\confident-mclaren-506b7a`；核对基线 `819669a`。进入含 frontend/backend 的目录，不在外层只有方案的 main 下另建应用。

```powershell
git status --short
git log -1 --oneline
```

保留已有未提交修改；不能 reset、清数据库或清浏览器缓存来“修复”测试。按下述任务形成小提交，只 stage 本任务文件。每个任务先写行为测试并看到预期失败，再实现和验证。

| 文件 | 职责 |
| --- | --- |
| `backend/app/main.py` | 在原工厂增加可选静态目录，原协作服务不变 |
| `scripts/serve.ps1` | 已构建应用的单进程前台启动，支持显式 TLS |
| `frontend/vite.config.ts` | SW 生成配置，原 dev 代理不变 |
| `frontend/src/offline.ts` | 一次性注册与页面缓存/版本提示状态，无正文处理 |
| `frontend/src/documents/backup.ts` | 备份格式、检查、编解码、纯文本预览 |
| `frontend/src/documents/DocumentBackup.vue` | 导出、选择、预览、打开原文档、确认合并 |
| `frontend/src/clipboard.ts` | 剪贴板能力检测及成功/失败结果 |
| `frontend/src/App.vue` | 连接现有界面；保留会话代次防护，不变成新路由框架 |
| `frontend/e2e-production/` | 构建版真实离线、备份和复制行为验收 |

执行顺序：Task 1 → Task 2 → Task 3 → Task 4 → Task 5。备份与复制在职责上独立，但均涉及 App.vue，建议顺序合入，避免多人同时修改它。测试代码不进入产品运行路径。

## Task 1：FastAPI 可选静态服务与前台启动脚本

**Files:** 修改 `backend/app/main.py`；新增 `backend/tests/test_static_app.py`、`scripts/serve.ps1`；在 `README.md` 增加最短构建版运行命令。

**Interfaces:**

工厂签名增加关键字参数：`create_app(data_directory: Path | str = DEFAULT_DATA_DIRECTORY, *, static_directory: Path | str | None = None) -> FastAPI`。模块级 app 同时读取 COLLAB_DATA_DIR 和可选 COLLAB_STATIC_DIR；原 lifespan/API/WS 保持原职责。

后文代码块给出公共接口、关键集成代码及行为测试；在现有文件中补齐实现，不重写原有模块。

- [ ] **先增加 B1 测试。** 使用 tmp_path 构造 dist，仅放 index.html、sw.js、assets/app-test.js；用 TestClient 和临时数据目录验证以下行为。

```python
def test_unknown_api_is_not_html(tmp_path):
    from fastapi.testclient import TestClient
    from app.main import create_app

    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<main>offline shell</main>", encoding="utf-8")
    with TestClient(create_app(tmp_path / "data", static_directory=dist)) as client:
        assert client.get("/").status_code == 200
        assert client.head("/").status_code == 200
        response = client.get("/api/not-a-route")
        assert response.status_code == 404
        assert "offline shell" not in response.text
        assert client.get("/missing.js").status_code == 404
        assert client.get("/api/health").json() == {"status": "ok"}
```

另测：无 static_directory 时不依赖 dist；显式配置不存在目录时启动清晰失败；index/sw 的 no-cache、assets 的 immutable；不允许路径穿越；原有效 WS 可连接、未知 WS 路径正常拒绝而非 StaticFiles assertion。

- [ ] **运行定向测试，确认失败在尚无 static_directory 接口。**

```powershell
backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/tests/test_static_app.py -q
```

- [ ] **在原 API/WS 注册之后添加静态 HTTP 路由。** 复用 StaticFiles，不手写文件读取和安全路径解析。核心形态如下：

```python
from fastapi import HTTPException
from starlette.staticfiles import StaticFiles

if static_directory is not None:
    static = StaticFiles(directory=Path(static_directory).resolve(), html=True)

    @app.api_route("/{asset_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def frontend_asset(asset_path: str, request: Request):
        if asset_path in {"api", "ws"} or asset_path.startswith(("api/", "ws/")):
            raise HTTPException(status_code=404)
        response = await static.get_response(asset_path or ".", request.scope)
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable"
            if asset_path.startswith("assets/")
            else "no-cache"
        )
        return response
```

不要加任意路径 index.html fallback；hash 文档路由只需请求 `/`。不要 mount 一个会接住所有未知 WebSocket 的静态子应用。

- [ ] **编写 serve.ps1。** 参数为 HostAddress=`127.0.0.1`、Port=`5274`、可选 CertFile/KeyFile。验证 Python、dist/index.html 存在；两个证书参数必须同时提供且文件存在；Port 为 1–65535。脚本从项目根运行，设置 UTF-8 及 COLLAB_STATIC_DIR 的绝对路径，保留用户的 COLLAB_DATA_DIR。

```powershell
# 已完成参数及文件检查后构造参数数组，禁止字符串拼接执行。
$serverArgs = @(
    '-m', 'uvicorn', 'app.main:app', '--app-dir', 'backend',
    '--host', $HostAddress, '--port', "$Port", '--workers', '1'
)
if ($CertFile) {
    $serverArgs += @('--ssl-certfile', $CertFile, '--ssl-keyfile', $KeyFile)
}
& $python @serverArgs
exit $LASTEXITCODE
```

不使用保留变量 `$Host`、后台 Start-Process、--reload 或 taskkill；Ctrl+C 交给 Uvicorn 正常停机。遇到 SSL 配置错误直接失败，不静默降级 HTTP。不自动构建/装依赖，缺少 dist 时提示 `npm --prefix frontend run build`。

- [ ] **验证并提交。** 定向测试通过后跑后端全套；临时数据目录启动构建版，访问首页和文档、正常 Ctrl+C、再启动恢复。记录命令和实际退出情况。

```powershell
backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/tests -q
npm --prefix frontend run build
powershell -File scripts/serve.ps1
git add backend/app/main.py backend/tests/test_static_app.py scripts/serve.ps1 README.md
git commit -m "feat: serve built editor through FastAPI"
```

**Review 条件：** 一个端口提供页面/API/WS，原 API-only 使用方式保持有效。不要更改 collaboration.py 的同步、保存和关闭逻辑。

## Task 2：生产页面缓存与真实离线测试

**Files:** 修改 `frontend/package.json`、`frontend/package-lock.json`、`frontend/vite.config.ts`、`frontend/src/main.ts`、`frontend/src/App.vue`；新增 `frontend/src/offline.ts`、`frontend/src/env.d.ts`（已有则追加）、`frontend/playwright.production.config.ts`、`frontend/e2e-production/fixtures.ts`、`frontend/e2e-production/offline.spec.ts`；修改 `backend/tests/uvicorn_launcher.py` 以读取可选静态目录。

**Interfaces:** offline.ts 导出只读 Vue refs `pageCacheReady`、`updateAvailable`、`offlineUnavailableReason` 及仅启动一次的 `registerOfflineShell(): void`。main.ts 在 mount 前调用。此模块不接触 Y.Doc、IndexedDB 或编辑器实例。

- [ ] **先创建生产 E2E fixture 和 B2/B3 失败测试。** production config 只选择 e2e-production，workers=1、retries=0、serviceWorkers=allow。增加 npm script `test:e2e:production`=`playwright test --config playwright.production.config.ts`。用现有测试启动器启动临时 SQLite 数据目录和临时静态目录，端口 5483；不启动 Vite dev。扩展启动器仅将 COLLAB_STATIC_DIR 传给 create_app，原测试默认行为不变。

测试独立使用 browser.newContext，退出时通过 stdin `stop` 正常结束所创建的服务进程，随后清理对应临时目录；失败时保留日志。不要关闭用户已运行的 5273/8787 服务。

```ts
// 创建文档并编辑、确认本地恢复条件后，在同一 context 中执行。
await page.evaluate(async () => { await navigator.serviceWorker.ready })
await page.reload()
await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
await context.setOffline(true)
const response = await page.reload()
expect(response?.fromServiceWorker()).toBe(true)
await expect(page.locator('.tiptap')).toContainText('离线前正文')
await page.locator('.tiptap').click()
await page.keyboard.press('ControlOrMeta+End')
await page.keyboard.insertText('离线新增')
```

随后再次离线刷新，断言新增及删除均保留；恢复网络，用另一 context 确认合并。等待条件使用持久化恢复的可观察结果或测试侧只读 IndexedDB 检查，不新增“已保存”产品标志、不使用固定 sleep 假装落盘。

另测：缓存了页面但没有该 UUID 正文，离线打开不创建空编辑器；离线 API 请求失败，不返回 index.html；CacheStorage 不存 API/WS；新 context 从未访问时离线首次访问不声称可用。为 wait/serviceworker 设有限超时，当前无 SW 时失败应可诊断而非一直挂起。

- [ ] **添加固定依赖并运行基线失败用例。** 保留 lockfile，其余包不集中升级。

```powershell
npm --prefix frontend install -D --save-exact vite-plugin-pwa@1.3.0
npm --prefix frontend run build
npm --prefix frontend run test:e2e:production
```

- [ ] **增加 VitePWA 配置，保留原开发代理。**

```ts
import { VitePWA } from 'vite-plugin-pwa'

VitePWA({
  strategies: 'generateSW',
  registerType: 'prompt',
  injectRegister: false,
  manifest: false,
  devOptions: { enabled: false },
  workbox: {
    globPatterns: ['**/*.{html,js,css,svg,png,ico,woff2}'],
    navigateFallback: 'index.html',
    navigateFallbackAllowlist: [/^\/(?:index\.html)?(?:\?.*)?$/],
    runtimeCaching: [],
    cleanupOutdatedCaches: true,
    skipWaiting: false,
    clientsClaim: true,
  },
})
```

确认本项目实际 bundle 大小在 Workbox 预缓存上限内；有构建警告时核对具体文件，不能忽略导致入口 JS 不缓存的警告。不要预缓存 sourcemap、数据库、备份文件或远程 CDN。

- [ ] **注册一次 SW 并连接轻量提示。** env.d.ts 引入 `vite-plugin-pwa/client` 类型。仅在 `import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator` 时注册；其他情况给准确原因且不阻塞编辑器。

```ts
import { registerSW } from 'virtual:pwa-register'

registerSW({
  immediate: true,
  onOfflineReady() { pageCacheReady.value = true },
  onNeedRefresh() { updateAvailable.value = true },
  onNeedReload() { updateAvailable.value = true },
  onRegisterError() {
    offlineUnavailableReason.value = '页面缓存未准备好，当前不能保证离线刷新。'
  },
})
```

已安装 SW 的后续访问需通过当前应用的 registration/ready/controller 恢复 pageCacheReady 状态，不能仅依赖首次 onOfflineReady 回调。失效或失败不显示成功。不要调用 registerSW 返回的更新函数，不监听版本事件自动 reload。提示采用设计文档的文案；HTTP LAN 下说明需要可信 HTTPS，开发模式说明离线页面缓存仅在构建版启用。

- [ ] **增加 B4 更新测试。** 测试临时目录准备构建 A/B：复制真实 dist，在 B 的 index.html 添加无行为的版本注释，用安装后的 Workbox generateSW 按上述相同规则重新生成预缓存清单；不修改工作区源码、不 mock SW 主脚本请求。测试服务始终提供同一临时路径，在 fixture 内切换完整 B 产物，保留 A 哈希 assets 直到测试结束。

两个 A 页面均在编辑时执行 registration.update；断言 waiting 存在及版本提示出现，两页都不触发 reload、光标/正文仍在。随后关闭该 context 的全部 app 页面但不销毁 context，重新打开并确认 B 由 active worker 提供，IndexedDB 正文仍在。另确认 Vite dev 不注册 SW。更新 fixture 只用于测试，产品不增加自定义更新服务。

- [ ] **运行并提交。** 运行单测、类型检查、构建与新套件。测试生成的临时文件不 stage。

```powershell
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run test:e2e:production
git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/src/main.ts frontend/src/App.vue frontend/src/offline.ts frontend/src/env.d.ts frontend/playwright.production.config.ts frontend/e2e-production backend/tests/uvicorn_launcher.py
git commit -m "feat: cache editor shell for offline reload"
```

**Review 条件：** B2/B3/B4 有真实构建版测试证据，正文通路未增加状态机。缓存完成提示不冒充服务器保存成功。

## Task 3：完整 Yjs 备份与同文档迁移

**Files:** 新增 `frontend/src/documents/backup.ts`、`frontend/src/documents/DocumentBackup.vue`、`frontend/tests/backup.test.ts`、`frontend/e2e-production/backup.spec.ts`；修改 `frontend/src/App.vue`、`frontend/src/documents/api.ts`（仅可选 AbortSignal）、必要的局部样式。

**Interfaces:**

```ts
export type DocumentBackupV1 = {
  format: 'dom-collab-backup'
  version: 1
  schema: 'paragraph-text-hardbreak-v1'
  documentId: string
  exportedAt: string
  sourceOrigin: string
  updateBase64: string
}
export type ParsedBackup = { metadata: DocumentBackupV1; update: Uint8Array; previewText: string }
export const MAX_BACKUP_FILE_BYTES = 8 * 1024 * 1024
export const MAX_BACKUP_UPDATE_BYTES = 4 * 1024 * 1024
// 导出函数返回 UTF-8 JSON；解析函数对完整 JSON 和内容检查，失败抛用户可读 Error。
export function serializeBackup(documentId: string, doc: Y.Doc, sourceOrigin: string): string
export function parseBackup(json: string): ParsedBackup
```

backup.ts 不导入 Vue/session，不发送网络请求。文件大小在 File.text() 前检查，parseBackup 仍校验 UTF-8 字节长度，防止绕过文件 UI 调用。

- [ ] **先写 B5/B6 codec 测试并确认失败。** 最小幂等测试形态：

```ts
test('完整备份重复应用不会重复正文', () => {
  const source = new Y.Doc()
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  source.getXmlFragment('body').insert(0, [paragraph])
  paragraph.insert(0, [text])
  text.insert(0, '你好协作')
  const id = '00000000-0000-4000-8000-000000000001'
  const parsed = parseBackup(serializeBackup(id, source, 'http://localhost:5273'))
  const target = new Y.Doc()
  Y.applyUpdate(target, parsed.update)
  Y.applyUpdate(target, parsed.update)
  expect(target.getXmlFragment('body').toString()).toBe(source.getXmlFragment('body').toString())
  source.destroy()
  target.destroy()
})
```

另测：先共享同一 seed，再源端离线插入/删除、目标端并发插入，导入后双方收敛；hardBreak、emoji、中文、空段落；非法 JSON/version/schema/UUID/Base64、超限、损坏 update、空根/错根/错节点。错误不能影响现有 Doc。

```powershell
npm --prefix frontend test -- tests/backup.test.ts
```

- [ ] **实现 codec。** 使用 `Y.encodeStateAsUpdate` 和 `Y.applyUpdate`，Base64 使用浏览器标准 btoa/atob 分块转换（不要对大数组展开 `String.fromCharCode(...bytes)`）。版本/schema/magic 精确匹配；UUID 规范化为标准小写格式；时间为合法 ISO 字符串；sourceOrigin 必须是无 path/query/hash/credentials 的 http/https origin，只展示不用作请求目标。

限制解码前 Base64 最大长度，严格检查字符与 padding，再验证解码字节数；不忽略异常。导出也执行相同大小检查。临时 Doc 先创建 body 根，再 apply，检查只有 body 共享根及至少一个 paragraph。用 Yjs 公共 API 检查 XmlElement 节点名、getAttributes、toArray、XmlText.toDelta；text insert 必须为字符串且没有格式 attributes，hardBreak 必须无子节点/属性。预览按段落连接 `\n`，hardBreak 同样是 `\n`，不渲染 HTML。用 finally 销毁临时 Doc。

核心合并只有：

```ts
Y.applyUpdate(session.doc, parsed.update, 'backup-import')
```

不使用 setContent 或 insertContent 替换 CRDT，不添加 txId 去重，不读 Yjs 私有字段。

- [ ] **接入持续挂载的 DocumentBackup 面板。** Props 为 `documentId: string | null`、`session: DocumentSession | null`；emit `open-document` 携带规范 UUID。App 在 home/document 条件分支之外只挂载一次组件；处理 emit 仅设置既有 hash，不创建第二套导航过程。

文件选择后显示 UUID、来源、时间、只读预览与说明；异 ID 时仅提供“打开原文档”，跳转后保留待导入文件。匹配且 canMountEditor 时可点击“合并备份”，明确这是合并，不是恢复到旧版本。所有预览/错误通过插值或 readonly textarea 显示。

导出只在当前会话可编辑时启用，直接读取 live Doc，离线也可用；Blob 下载后延后回收 object URL，不清缓存；文案不要声称用户已保存到磁盘。失败显示具体原因。

- [ ] **合并前做有限在线校验和身份重检。** 将 `readDocument(documentId, signal?: AbortSignal)` 的 signal 透传 fetch，保持其他调用行为。组件捕获当前 session、文件对象、UUID；8 秒 AbortController 超时，finally 清 timer。请求期间禁用重复提交。await 后任何身份或 canMountEditor 改变都取消，不向新会话写入。

```ts
const targetSession = props.session
const targetBackup = selectedBackup.value
const targetId = props.documentId
// 前置：三者非空、UUID 匹配、targetSession.canMountEditor.value 为 true。
// readDocument 使用当前 origin；超时/404/503 分别反馈，不把网络错误当不存在。
await readDocument(targetId, controller.signal)
if (props.session !== targetSession || selectedBackup.value !== targetBackup ||
    props.documentId !== targetId || !targetSession.canMountEditor.value) {
  throw new Error('当前文档或备份已改变，请重新确认导入。')
}
Y.applyUpdate(targetSession.doc, targetBackup.update, 'backup-import')
```

成功提示“备份已合并到当前正文；服务器持久化状态不由此操作确认”。404 保留预览并说明可复制到手动新建文档；离线保留预览、导出和手动复制，但合并按钮请求失败时明确要求连接服务端。组件卸载/换文件需中止或废弃旧请求，不让晚到结果覆盖新 UI。

- [ ] **补生产 E2E 并验证。** 用同一 Python 进程、同一端口分别通过 `http://127.0.0.1:5483` 与 `http://localhost:5483` 形成两个 origin；先确认两个地址访问同一文档元数据且浏览器存储隔离。不能为此启动两个 worker 共写同库。

在 A 打开文档后断网，插入和删除，导出文件；B 在线打开同 UUID、导入两次，断言不重复且保留 B 并发编辑；B 刷新后仍在，用独立客户端确认网络收敛。另测错 ID 不直接写当前文档、损坏文件、404、请求超时、检查期间切换到别的文档、切换文件，均不污染正文。HTTP 请求不可用时只提示失败，不暗中创建新文档。

```powershell
npm --prefix frontend test -- tests/backup.test.ts
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run test:e2e:production
git add frontend/src/documents/backup.ts frontend/src/documents/DocumentBackup.vue frontend/src/documents/api.ts frontend/src/App.vue frontend/src/styles.css frontend/tests/backup.test.ts frontend/e2e-production/backup.spec.ts
git commit -m "feat: export and merge same-document Yjs backups"
```

**Review 条件：** B5/B6 通过，session.ts 和后端协议不需要变更。迁移原 CRDT 历史，明确不提供“空服务器恢复文档目录”或“历史回滚”。

## Task 4：剪贴板失败的可见降级

**Files:** 新增 `frontend/src/clipboard.ts`、`frontend/tests/clipboard.test.ts`、`frontend/e2e-production/clipboard.spec.ts`；修改 `frontend/src/App.vue`、`frontend/src/editor/EditorPane.vue`、必要的局部样式。

**Interfaces:** `tryCopyText(text: string): Promise<boolean>`。不增加通用 UI 框架或为了两个按钮再拆复杂组件。

- [ ] **先加 B7 单测和文档页 UI 测试。** 分别模拟 insecure context、clipboard 不存在、writeText reject、writeText resolve。当前文档页复制失败应先复现“看不到错误/手动复制字段”。
- [ ] **实现 helper，并从用户 click 处理器直接调用。**

```ts
export async function tryCopyText(text: string): Promise<boolean> {
  if (!window.isSecureContext || !navigator.clipboard?.writeText) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
```

- [ ] **修正 App 的分享链接 UI。** 保留失败文本在复制按钮同一文档分支中，以带 label 的 readonly input 展示完整当前 shareLink，可聚焦/选择复制。成功才显示“已复制”，失败显示“请选中下方链接手动复制”；shareLink 变化后重置旧反馈。不要继续把文档页错误仅存入首页 linkError。
- [ ] **正文复制复用 helper。** 保留 EditorPane 的 `editor.getText({ blockSeparator: '\n' })` 和现有手动 textarea；不修改 paste handler、DOM selection、hardBreak 或协作 UndoManager。
- [ ] **验证并提交。** E2E 在点击前通过 context init script 暴露 API 不存在/拒绝的情况，验证真实页面降级字段值与当前地址一致且可以选择。另测合法剪贴板成功反馈；明确 mock 只是能力分支测试，不能代替 Task 5 的 HTTP LAN 手测。

```powershell
npm --prefix frontend test -- tests/clipboard.test.ts
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run test:e2e:production
git add frontend/src/clipboard.ts frontend/src/App.vue frontend/src/editor/EditorPane.vue frontend/src/styles.css frontend/tests/clipboard.test.ts frontend/e2e-production/clipboard.spec.ts
git commit -m "fix: expose manual copy fallback on document page"
```

**Review 条件：** B7 通过；API 不存在和权限被拒绝都可用，不使用 execCommand，不要求用户改浏览器安全标记。

## Task 5：运行指南、GitHub 文件边界和完整验收

**Files:** 修改 `README.md`、`docs/demo.md`、`.gitignore`、`scripts/verify.ps1`；新增 `docs/local-and-lan.md`、`docs/offline-lan-validation.md`。原中文输入清单仅记录真实执行结果。

- [ ] **写可复制的本地运行命令。** 用 Python 3.12 代替开发者机器绝对路径，Node 满足现有 Vite 的版本范围（20.19+ 或 22.12+ 的受支持版本）；安装时用 lockfile。开发模式仍为 5273，完整离线功能的构建版为 5274，避免生产 SW 接管开发 origin。仅关闭 dev SW 配置不能卸载已安装的生产 worker，不推荐让两种模式使用相同 origin。

```powershell
uv venv --python 3.12 backend/.venv
uv pip sync --python backend/.venv/Scripts/python.exe --require-hashes backend/requirements.lock
npm --prefix frontend ci
npm --prefix frontend run build
powershell -File scripts/serve.ps1
```

说明构建版默认访问 `http://127.0.0.1:5274`；正式验收在构建版运行。切换模式先停止旧后端，不同时启动两个指向同一 COLLAB_DATA_DIR 的 Python 进程；不同端口不代表可以共写数据库。开发地址中的未同步内容先导出再迁移。README 主路径按本项目 Windows 环境书写；附 Python venv POSIX 路径和直接 Uvicorn 命令即可，不承诺未测试的跨平台脚本。

- [ ] **写可信 HTTPS 局域网流程。** 用户查询本机实际 IPv4，建议路由器 DHCP 地址保留或固定主机名，统一分享该地址。mkcert 由用户自行安装，明确证书生成命令里的 IP 需要替换；下面使用示例地址而非开发者真实 IP。

```powershell
New-Item -ItemType Directory -Force .local-certs
mkcert -install
mkcert -cert-file .local-certs/lan.pem -key-file .local-certs/lan-key.pem localhost 127.0.0.1 192.168.1.100
powershell -File scripts/serve.ps1 -HostAddress 0.0.0.0 -Port 5274 -CertFile .local-certs/lan.pem -KeyFile .local-certs/lan-key.pem
```

访问设备须信任同一个根 CA 的**公钥证书**，服务端证书 SAN 覆盖实际访问地址；用 `mkcert -CAROOT` 定位并依据官方说明配置。不能分享 rootCA-key.pem；私钥和本地证书不进入 Git。脚本不自动安装 CA 或修改防火墙。

其他设备打开 `https://实际局域网IP:5274`，地址栏无证书错误且 `window.isSecureContext` 为 true。解释同源 API/WSS 自动适配，不填 localhost 后端给其他设备。排障包含：同一网络、Windows 专用网络入站端口、AP 客户端隔离、VPN、端口占用、证书 SAN/信任。由用户按需调整，不自动执行系统修改。

附 HTTP LAN 启动方式（省去证书参数），准确说明在线协作和复制降级可用，完整离线刷新不可用。由 HTTP 切 HTTPS 同样更换 origin，先导出未同步内容。

- [ ] **写备份和数据边界。** 用五步示例说明：旧地址打开原文档 → 导出备份 → 新地址选择备份 → 打开原文档 → 在线校验后合并。说明预览可离线使用、合并需要当前服务端在线；相同浏览器不同 origin、不同浏览器/设备都不共享缓存。

明确文件合并不是回滚；服务端数据丢失/换空服务器时不能自动恢复目录，预览可复制到手动新建的文档。重要数据可在服务器正常关闭后备份整个 COLLAB_DATA_DIR，包含 documents.sqlite3 和 updates.sqlite3；不要只复制元数据或在运行中随意复制 SQLite 主文件。

首次联网且页面资源缓存完成后再离线；正文必须在当前地址打开过并写入本地。浏览器清站点数据、隐私模式销毁及存储回收均可能移除本地副本，SW 不改变这些事实。

- [ ] **补 Git 忽略并核对公开文件。** 加 `.local-certs/`、`*.collab-backup.json`、`*.sqlite3`、`*.sqlite3-wal`、`*.sqlite3-shm`；现有 backend/data、.env、node_modules、dist 忽略继续有效。测试用备份由测试动态生成，不提交真实正文样本。不要擅自选择开源许可证，报告尚未选择即可。

```powershell
git check-ignore .local-certs/lan-key.pem example.collab-backup.json backend/data/v2/updates.sqlite3
git ls-files .env .local-certs backend/data frontend/dist
```

第二条预期无用户数据/私钥/构建产物；若存在已跟踪文件，先说明具体文件并保留本地数据，通过有针对性的取消跟踪解决，不直接删除用户文件。README 明确 GitHub 是源码托管；GitHub Pages 不能替代 Python/WebSocket 服务。不新增 Docker、云平台、CI 部署或登录系统。

- [ ] **将新 suite 接入 verify.ps1。** 现有后端、前端单测、typecheck、build、dev E2E 后再运行 `npm --prefix frontend run test:e2e:production`。保留任何一步失败立即退出的行为，并移除提示里的个人 Python 绝对路径。
- [ ] **运行全套自动验证一次。**

```powershell
powershell -File scripts/verify.ps1
git diff --check
```

实际记录每套测试数量和退出码，不复制旧的 39/20/39 结果当新验收。新增测试应进入全套；不能为了通过而删掉原 recovery/navigation/paste 用例。首次缺浏览器时按 Playwright 官方方式安装或使用已有 PLAYWRIGHT_CHROMIUM_PATH，不全局改环境。

- [ ] **填写 B8/B10 人工结果。** 两台真实设备、同一可信 HTTPS 地址：双人同段输入 → 一台断网 → 编辑/删除 → 全页刷新 → 内容仍在 → 恢复网络 → 两端收敛；同时测试 HTTP LAN 下链接手动复制。已有中文输入法、多行粘贴、选区替换、撤销重做按原清单回归。

不能接触第二设备或证书未准备好时，在 docs/offline-lan-validation.md 写“未验证”、缺少什么条件及可执行步骤；不假造通过，也不为了测试擅自信任 CA。自动测试完成后可交付，并明确人工验收状态。

- [ ] **形成最终提交和交接报告。**

```powershell
git add README.md docs/demo.md docs/local-and-lan.md docs/offline-lan-validation.md .gitignore scripts/verify.ps1
git commit -m "docs: document offline and trusted LAN operation"
git status --short
```

报告仅包含：各任务提交、核心文件、实际验证结果、未实测项目，以及本地/局域网启动方法。不要把新增 UI 功能堆成演示平台，不把已连接写成已保存，不执行 GitHub 推送。
