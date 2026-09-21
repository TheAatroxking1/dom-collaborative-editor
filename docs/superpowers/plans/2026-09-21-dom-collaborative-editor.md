# DOM Collaborative Editor Implementation Plan

> **执行状态（2026-09-21 补记）：** 任务 1–9 已按本计划实施完成。实际运行结果：
> 后端 pytest 80 项、前端 Vitest 52 项、Playwright 端到端 27 项全部通过，
> `scripts/verify.ps1` 退出码为 0。下列步骤复选框未逐条勾选，因为实施过程中存在
> 若干与本计划不同的实测结论，逐条勾选会掩盖这些差异；实际交付内容以 `README.md`
> 与代码为准。与计划的偏差：
>
> - **pycrdt 0.14.5 的实际 API**：差量编码是 `doc.get_update(state_vector)`，
>   没有模块级 `get_update`；索引式删除是 `del text[a:b]`，没有 `text.delete()`。
>   并且它的索引按 Python 码点计数，与 Yjs 的 UTF-16 码元不一致，多字节文本上会
>   误删或抛 Rust panic。服务端只应用二进制更新、读取快照与编码状态，不按索引编辑
>   正文，因此不受影响；该边界记录在 `backend/tests/test_crdt.py` 模块说明中。
> - **端到端端口**：本机 8000/8001/5173 已被其他项目占用。按“不按端口结束未知进程”
>   的要求，改用 8791（后端）与 5473（前端），可用环境变量覆盖。
> - **受限网络**：若无法从官方源下载 Chromium，可用 `PLAYWRIGHT_CHROMIUM_PATH`
>   指向本机已有的浏览器。
> - **载荷类型的两处补充**：`ProviderState` 增加 `errorCode`（界面需要区分
>   “文档不存在”），`SessionState` 增加 `paused`（待发送内容超限时暂停新增编辑），
>   `DocumentSession` 增加 `events`（折叠调试面板的数据）。均为附加字段。
> - **广播不回流给提交者**：提交者已经持有该内容且会收到 ACK，因此服务端广播时排除
>   该连接。
> - **PowerShell 脚本需要 UTF-8 BOM**：Windows PowerShell 5.1 对无 BOM 的 UTF-8
>   脚本按系统代码页解析，中文会直接导致语法错误。
> - **中文输入法验收未执行**：`docs/manual-ime-checklist.md` 全部标记为未执行，
>   没有用合成 composition 事件冒充人工通过。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可在两个浏览器中同段并发编辑、具有本地恢复和服务端持久化确认的 DOM 编辑器，并提供可重复的异常场景验证。

**Architecture:** Vue 负责应用界面，Tiptap / ProseMirror 将 DOM 编辑映射到 Yjs 文档。自建 WebSocket provider 与 FastAPI / pycrdt 交换 Yjs V1 更新，SQLite 提交后才发送 ACK；浏览器将原始更新和待确认事务统一记录到 IndexedDB。

**Tech Stack:** Vue 3、TypeScript、Vite、Tiptap 3、Yjs 13、Python 3.12、FastAPI、pycrdt、SQLite、IndexedDB、Vitest、pytest、Playwright。

## Global Constraints

- “默认采用UTF-8，因为你会遇见很多中文”。
- “用户确认：前端使用 Vue，后端使用 Python。”
- “用户确认：允许两个人在同一段内同时打字。”
- “用户确认：采用 Tiptap / ProseMirror 编辑内核，结合 Yjs；我们开发界面、Python 同步服务、保存与恢复机制。”
- “首版使用开放文档链接进行本地或受控环境演示；一个 Python 进程管理文档房间。”
- “默认正文为空，提示文字仅使用占位符展示。”
- “本地日志中已 ACK 的记录保留，用状态字段将其移出待发送队列，而不是立即删除原始更新。”
- “服务启动和房间重新加载时，先恢复文档日志，再接受握手及写入。”
- “页面重新加载后保留正文，不承诺保留上一会话的撤销栈。”
- “尚未执行这些测试，本表是后续验收要求。”

---

## 0. 起点、边界和工作方式

设计依据：`docs/superpowers/specs/2026-09-21-dom-collaborative-editor-design.md`。用户已确认该路线并要求继续。当前仓库只有设计文档，没有应用代码或可运行测试；本计划中的代码和命令是执行说明，不代表已经实施或验证通过。

已检查的本机环境：项目根目录 `F:\基于DOM的协作编辑器`，Node `24.15.0`、npm `11.12.1`、uv `0.12.7`；`D:\Python\python.exe` 为 Python `3.12.4` AMD64。裸 `python` 命中全局 Anaconda Python `3.14.6`，因此以下命令显式使用项目虚拟环境。

本文所有相对路径均相对于执行工作区根目录；PowerShell 命令也从该根目录运行。若执行时采用工作树，使用工具返回的实际路径。不要改写全局 Python、npm 或 Git 配置。依赖安装只发生在执行阶段。

任务按依赖顺序执行，每项以有意义的失败测试、实现、通过验证、审查和小提交结束。文档、样式和脚手架并入相关功能任务，不为低风险静态配置单独编造测试。任务 2 与任务 4 可在任务 1 接口稳定后独立推进；任务 3、5、6 按依赖集成。

建议形成三个可运行检查点：任务 1–3 得到可持久化的真实同步服务；任务 4–6 得到可用编辑器；任务 7–9 得到异常验证和交付材料。

### 已核对的依赖候选

2026-09-21 已逐项通过 npm Registry / PyPI 查询版本存在性，并核对主要 peer / engines；这些是执行起点，不代表已经安装或通过互通测试。依赖文件不使用 `latest`，Task 1 完成后提交实际锁文件。

| npm 包 | 固定版本 |
| --- | --- |
| vue | 3.5.43 |
| vite / @vitejs/plugin-vue | 8.3.0 / 6.0.9 |
| typescript / vue-tsc / @types/node | 5.9.3 / 3.3.11 / 24.10.1 |
| @tiptap/vue-3、@tiptap/core、@tiptap/pm | 均为 3.31.3 |
| @tiptap/extension-document、@tiptap/extension-paragraph、@tiptap/extension-text、@tiptap/extension-hard-break、@tiptap/extension-collaboration | 均为 3.31.3 |
| @tiptap/y-tiptap | 3.0.9 |
| yjs / y-protocols / @floating-ui/dom | 13.6.32 / 1.0.7 / 1.8.0 |
| vitest / fake-indexeddb / @playwright/test | 5.0.1 / 6.2.5 / 1.63.0 |

`backend/requirements.in` 使用以下完整顶层约束：

```text
fastapi==0.141.1
uvicorn[standard]==0.53.0
pycrdt==0.14.5
pydantic==2.13.5
pytest==9.1.1
httpx==0.28.1
```

`pycrdt 0.14.5` 有 Python 3.12 和 3.14 的 Windows AMD64 wheel；选本机独立 Python 3.12 是为了明确环境归属，并非 3.14 无法安装。Tiptap Collaboration 的 Yjs peer 是 `^13`，前端固定 Yjs 13 并统一使用 V1 编码。TypeScript 固定 5.9.3，与 vue-tsc 的传统 TypeScript API 路径一致。

元数据参考：[Tiptap Collaboration](https://registry.npmjs.org/@tiptap%2fextension-collaboration/3.31.3)、[y-tiptap](https://registry.npmjs.org/@tiptap%2fy-tiptap/3.0.9)、[Vite](https://registry.npmjs.org/vite/8.3.0)、[Vitest](https://registry.npmjs.org/vitest/5.0.1)、[pycrdt](https://pypi.org/pypi/pycrdt/0.14.5/json)。本计划不引入 y-indexeddb，以免与统一日志重复管理持久化生命周期。

## 1. 文件与职责

```text
.gitignore                              本地依赖、数据库、测试产物忽略规则
.editorconfig                           UTF-8、换行和缩进
README.md                               启动、测试、设计摘要与限制
backend/requirements.in                 精确顶层依赖
backend/requirements.lock               带哈希的完整 Python 依赖
backend/pyproject.toml                   pytest 配置
backend/app/__init__.py                  Python 包
backend/app/crdt.py                      文档创建、克隆、应用与差量
backend/app/store.py                     SQLite 文档和更新日志
backend/app/protocol.py                  协议校验、大小限制与错误类型
backend/app/room.py                      单文档串行提交、订阅与恢复
backend/app/main.py                      FastAPI 工厂、HTTP 与 WebSocket 接口
backend/tests/conftest.py                临时数据库和应用 fixture
backend/tests/__init__.py                测试桥接模块的包入口
backend/tests/test_crdt.py               Python CRDT 行为
backend/tests/test_store.py              提交、去重、隔离、恢复
backend/tests/test_protocol.py           输入校验与协议边界
backend/tests/test_websocket.py          真实 ASGI WebSocket 接口
backend/tests/interop_bridge.py          Node 测试调用的 Python 二进制桥
backend/tests/e2e_server.py              仅测试进程装载的故障门控服务
frontend/package.json                   前端依赖和执行命令
frontend/package-lock.json              npm 锁文件
frontend/index.html                     页面入口
frontend/vite.config.ts                 Vue、API 和 WebSocket 代理
frontend/tsconfig.json                  TypeScript 配置
frontend/src/main.ts                    Vue 入口
frontend/src/App.vue                    文档入口与路由切换
frontend/src/styles.css                 布局、响应式、焦点与状态样式
frontend/src/editor/EditorPane.vue      DOM 编辑器及撤销重做操作
frontend/src/editor/extensions.ts       最小段落 schema 和协作绑定
frontend/src/documents/api.ts           创建和读取文档元数据
frontend/src/documents/session.ts       恢复、挂载、关闭与保存状态聚合
frontend/src/collab/protocol.ts          TypeScript 消息类型和编解码
frontend/src/collab/journal.ts           IndexedDB 日志及确认状态
frontend/src/collab/provider.ts          握手、发送、ACK、重连
frontend/src/collab/save-state.ts        可独立测试的保存状态计算
frontend/tests/interop.test.ts          Yjs 与 pycrdt 往返、删除与幂等
frontend/tests/journal.test.ts          本地恢复、确认、失败与隔离
frontend/tests/provider.test.ts         有序传输和旧会话隔离
frontend/tests/save-state.test.ts       保存状态边界
frontend/playwright.config.ts           独立浏览器上下文和测试进程配置
frontend/e2e/fixtures.ts                浏览器、后端进程与故障控制夹具
frontend/e2e/editor.spec.ts             编辑、并发、选区和撤销
frontend/e2e/recovery.spec.ts           丢包、断线、刷新和崩溃
scripts/dev.ps1                         开发启动入口
scripts/verify.ps1                      有序运行自动验证
docs/demo.md                            演示步骤与预期结果
docs/manual-ime-checklist.md            真实中文输入法验收记录
```

不要把 IndexedDB、WebSocket 和编辑器生命周期全部写进 Vue 组件；不要通过覆盖编辑器 innerHTML 实现远端同步。

## 2. 共享契约

### 2.1 协议与限制

采用 JSON 信封与 Base64 二进制字段。协议版本固定 `1`，客户端每次 WebSocket 连接产生新 UUID `syncId`，每个可重试事务产生 UUID `txId`。`documentId`、`syncId`、`txId` 均按 UUID 校验。事务去重键不包含 syncId，因此同一事务可以跨连接重试。

`frontend/src/collab/protocol.ts` 中的消息契约如下；Python 使用对应的 Pydantic 模型，禁止额外字段，数字不得把布尔值当整数接受。

```ts
export type Envelope = {
  v: 1
  documentId: string
  syncId: string
}
export type ClientMessage = Envelope & (
  | { type: 'hello'; stateVector: string }
  | { type: 'tx'; txId: string; kind: 'edit' | 'catchup'; update: string }
  | { type: 'sync-end'; barrierId: string }
)
export type ServerMessage = Envelope & (
  | { type: 'sync'; update: string; stateVector: string; seq: number }
  | { type: 'update'; update: string; seq: number }
  | { type: 'ack'; txId: string; seq: number }
  | { type: 'ready'; barrierId: string; seq: number }
  | { type: 'error'; code: string; retryable: boolean; message: string }
)
export const PROTOCOL_VERSION = 1
export const MAX_UPDATE_BYTES = 1024 * 1024
export const MAX_FRAME_BYTES = 2 * 1024 * 1024
export const MAX_PENDING_BYTES = 8 * 1024 * 1024
export const MAX_OUTGOING_FRAMES = 256
```

候选完整 CRDT 状态也不得超过 `MAX_UPDATE_BYTES`，保证它仍能通过重连通道传输。客户端待发送更新累计超过 8 MiB 时暂停新增编辑并提供复制文本，保留已有记录；服务端连接发送队列超过 256 帧时关闭该慢连接（1013），由正常重连补同步恢复。限制适用于本次小文档演示，不宣称大文档能力。

固定错误码：`BAD_MESSAGE`、`UNSUPPORTED_VERSION`、`DOCUMENT_NOT_FOUND`、`TX_PAYLOAD_MISMATCH`、`UPDATE_TOO_LARGE`、`INVALID_UPDATE`、`STORAGE_UNAVAILABLE`、`ROOM_UNAVAILABLE`。仅后两者可自动重试；错误时不发送成功 ACK。

### 2.2 Python 接口

```python
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from pycrdt import Doc

@dataclass(frozen=True)
class DocumentMeta:
    document_id: str
    created_at: str

@dataclass(frozen=True)
class Receipt:
    tx_id: str
    seq: int
    duplicate: bool

@dataclass(frozen=True)
class StoredUpdate:
    tx_id: str
    seq: int
    payload: bytes

class StoreContract(Protocol):
    def create_document(self, initial_update: bytes) -> DocumentMeta: ...
    def get_document(self, document_id: str) -> DocumentMeta | None: ...
    def load_updates(self, document_id: str) -> list[StoredUpdate]: ...
    def lookup(self, document_id: str, tx_id: str, payload: bytes) -> Receipt | None: ...
    def append(self, document_id: str, tx_id: str, payload: bytes) -> Receipt: ...

class CrdtContract(Protocol):
    def new_document(self) -> Doc: ...
    def restore_document(self, updates: list[bytes]) -> Doc: ...
    def candidate_document(self, current: Doc, update: bytes) -> Doc: ...
```

这里的 `Protocol` 是接口声明，省略号不是生产实现。具体函数在对应任务中实现。`SqliteStore(path: Path)` 实现 StoreContract；CRDT 使用同名模块级函数。Store 方法是同步接口，FastAPI / Room 通过 `asyncio.to_thread` 调用 SQLite 操作；CRDT 操作保留在单事件循环线程中。

Room 接口为 `Room(document_id, store, hooks)`、`await join(peer, state_vector)`、`await submit(peer, tx_id, payload)`、`await barrier(peer, barrier_id)`、`await leave(peer)`。Peer 包含 `sync_id` 和有界 FIFO `outgoing`；每个连接只有一个 writer coroutine。Hooks 默认异步空操作，仅测试注入实现。

### 2.3 本地日志与会话接口

```ts
import type * as Y from 'yjs'

export type JournalRecord = {
  documentId: string
  order: number
  source: 'local' | 'remote' | 'catchup'
  update: Uint8Array
  txId: string | null
  acknowledged: boolean
}
export type PendingTx = Pick<JournalRecord, 'order' | 'update'> & {
  txId: string
  kind: 'edit' | 'catchup'
}
export interface Journal {
  restore(documentId: string, doc: Y.Doc): Promise<void>
  appendLocal(documentId: string, update: Uint8Array, kind?: 'edit' | 'catchup'): Promise<PendingTx>
  appendRemote(documentId: string, update: Uint8Array): Promise<void>
  pending(documentId: string): Promise<PendingTx[]>
  acknowledge(documentId: string, txId: string): Promise<void>
  close(): void
}
export type SaveInputs = {
  restored: boolean
  connected: boolean
  ready: boolean
  localWrites: number
  unacknowledged: number
  localError: boolean
  remoteError: boolean
}
export type SaveState = 'restoring' | 'saving-local' | 'local-only' |
  'saved' | 'local-error' | 'remote-error'
```

`openJournal(name = 'dom-collab-v1'): Promise<Journal>`。生产数据库由同源标签页共享，日志自增顺序由 IndexedDB 分配，不能使用内存计数器。所有记录都按 documentId 隔离。每个 Y.Doc 自行生成活动客户端身份。

provider 与 session 使用以下类型；socketFactory 和 clock 默认使用真实 WebSocket / 定时器，测试可注入。恢复和 provider 属于 session，不属于 EditorPane。

```ts
import type { ShallowRef } from 'vue'

export type SocketLike = Pick<WebSocket,
  'readyState' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onclose' | 'onerror'>
export type Clock = {
  schedule(callback: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
  random(): number
}
export type ProviderState = SaveInputs & { message: string | null }
export type ProviderOptions = {
  documentId: string
  doc: Y.Doc
  journal: Journal
  url: string
  onState: (state: ProviderState) => void
  socketFactory?: (url: string) => SocketLike
  clock?: Clock
}
export type SessionState = {
  save: SaveState
  connected: boolean
  pending: number
  message: string | null
}
export interface DocumentSession {
  doc: Y.Doc
  canMountEditor: ShallowRef<boolean>
  state: ShallowRef<SessionState>
  retry(): void
  close(): Promise<void>
}
```

`CollabProvider(options: ProviderOptions)` 公开 `start(): Promise<void>`、`retry(): void`、`stop(): Promise<void>`。`openDocumentSession(documentId: string): Promise<DocumentSession>` 实现恢复、编辑挂载条件和 provider 状态聚合。Task 1 的 typecheck 会先覆盖现有代码，每项任务增加新模块后继续检查其实际类型。

## Task 1: 工程入口与跨语言 CRDT 互通

**Files:** 创建基础配置、`backend/app/crdt.py`、`backend/tests/test_crdt.py`、`backend/tests/interop_bridge.py`、`frontend/tests/interop.test.ts` 及两端依赖文件。

**Interfaces:** 消费第 2 节契约；产出 `new_document()`、`restore_document(updates)`、`candidate_document(current, update)`，以及可执行的 pytest / Vitest / TypeScript 命令。

- [ ] **Step 1: 配置项目局部环境和执行入口。** `.gitignore` 排除 `backend/.venv/`、`frontend/node_modules/`、`frontend/dist/`、`__pycache__/`、`.pytest_cache/`、`*.db`、`*.db-wal`、`*.db-shm`、`frontend/test-results/`、`frontend/playwright-report/`；跟踪 `.env.example`，忽略 `.env`。`.editorconfig` 设 UTF-8、LF、文件末尾换行；Python 4 空格，TS/Vue 2 空格。前端 scripts 定义 `dev: vite`、`build: vue-tsc --noEmit && vite build`、`typecheck: vue-tsc --noEmit`、`test: vitest run`、`test:interop: vitest run tests/interop.test.ts`、`test:e2e: playwright test`。Vite 固定本地 5173，代理 `/api` 与 `/ws` 到 `127.0.0.1:8000`；测试覆盖目标由环境变量传入。

```powershell
uv venv --python 'D:\Python\python.exe' backend/.venv
uv pip compile backend/requirements.in --python-version 3.12 --generate-hashes --output-file backend/requirements.lock
uv pip sync --python backend/.venv/Scripts/python.exe --require-hashes backend/requirements.lock
npm --prefix frontend install
```

Vitest 的 include 固定为 `tests/**/*.test.ts`，避免把 Playwright 的 e2e/*.spec.ts 当单测收集。TypeScript 开启 strict、ES2022、DOM / DOM.Iterable、ESNext module、Bundler moduleResolution 和 skipLibCheck，types 为 vite/client 与 node。安装 Playwright 浏览器使用 `npm exec --prefix frontend -- playwright install chromium`。

- [ ] **Step 2: 先写结构与克隆隔离的失败测试。** `backend/tests/test_crdt.py` 中使用真实 pycrdt，不用 Mock 替代合并器。

```python
from pycrdt import Doc, Text, XmlFragment
from app.crdt import new_document, restore_document, candidate_document

def test_new_document_has_one_shared_empty_paragraph():
    doc = new_document()
    root = doc.get("body", type=XmlFragment)
    assert len(root.children) == 1
    assert root.children[0].tag == "paragraph"
    assert len(root.children[0].children) == 0

def test_candidate_does_not_mutate_committed_document():
    committed = new_document()
    incoming = Doc()
    incoming.get("probe", type=Text).insert(0, "中文🙂")
    candidate = candidate_document(committed, incoming.get_update())
    assert str(candidate.get("probe", type=Text)) == "中文🙂"
    assert str(committed.get("probe", type=Text)) == ""
    restored = restore_document([candidate.get_update()])
    assert str(restored.get("probe", type=Text)) == "中文🙂"
```

运行 `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/tests/test_crdt.py -q`；首次应因 app.crdt 缺失失败，不能把缺依赖当作预期功能失败。pytest 设置 `pythonpath = ["."]`，配置文件在 backend 下。

- [ ] **Step 3: 实现 CRDT 适配函数。** 创建文档时服务端只初始化一次规范空段落，并持久化这份共享种子；它没有示例正文。首次访问的浏览器拿到种子前不挂载会自行补空段落的编辑器。

```python
from pycrdt import Doc, XmlElement, XmlFragment

def new_document() -> Doc:
    doc = Doc()
    root = doc.get("body", type=XmlFragment)
    root.children.append(XmlElement("paragraph"))
    return doc

def restore_document(updates: list[bytes]) -> Doc:
    doc = Doc()
    for update in updates:
        doc.apply_update(update)
    return doc

def candidate_document(current: Doc, update: bytes) -> Doc:
    candidate = restore_document([current.get_update()])
    candidate.apply_update(update)
    return candidate
```

- [ ] **Step 4: 增加 Node → Python → Node 实际二进制往返。** bridge 从 stdin 读取 `{"updates": [base64]}`，调用 restore_document，然后向 stdout 仅输出 `{"update": base64(doc.get_update()), "stateVector": base64(doc.get_state())}`。`backend/tests/interop_bridge.py` 的完整桥接内容如下，执行时使用 `python -m tests.interop_bridge` 并创建空的 `backend/tests/__init__.py`，工作目录为 backend。

```python
import base64
import json
import sys
from app.crdt import restore_document

request = json.load(sys.stdin)
updates = [base64.b64decode(value, validate=True) for value in request["updates"]]
doc = restore_document(updates)
json.dump({
    "update": base64.b64encode(doc.get_update()).decode("ascii"),
    "stateVector": base64.b64encode(doc.get_state()).decode("ascii"),
}, sys.stdout)
```

Node 测试使用下列 helper 启动项目虚拟环境解释器；设置 Vitest testTimeout=15000，允许 Windows 冷启动 Python，但失败诊断仍依赖断言而不是 sleep。

```ts
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

function roundTrip(updates: Uint8Array[]): Uint8Array {
  const backend = resolve(process.cwd(), '../backend')
  const python = resolve(backend, '.venv/Scripts/python.exe')
  const result = spawnSync(python, ['-m', 'tests.interop_bridge'], {
    cwd: backend,
    encoding: 'utf8',
    input: JSON.stringify({ updates: updates.map((value) => Buffer.from(value).toString('base64')) }),
    timeout: 10000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr)
  return Uint8Array.from(Buffer.from(JSON.parse(result.stdout).update, 'base64'))
}
```

测试用 `Y.Doc.getXmlFragment('body') → paragraph → Y.XmlText` 建立 `Hello中文🙂`，往返后分别验证结构、重复应用幂等，以及在相同基线上两个副本并发插入后无论更新顺序如何都得到相同内容。另以 Y.Text 做仅删除测试，明确比较删除前后 state vector 相同，但删除更新仍能跨 Python 传播。

```ts
import * as Y from 'yjs'
import { expect, test } from 'vitest'

test('delete-only update must not be skipped for equal state vectors', () => {
  const a = new Y.Doc()
  const b = new Y.Doc()
  a.getText('probe').insert(0, 'Hello中文🙂')
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const before = Y.encodeStateVector(a)
  a.getText('probe').delete(5, 2)
  expect(Y.encodeStateVector(a)).toEqual(before)
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  expect(b.getText('probe').toString()).toBe('Hello🙂')
})
```

跨语言用例把原始基线与删除 update 都交给 roundTrip，应用返回结果到全新 Y.Doc 后断言为 `Hello🙂`，不能只给空白 Python 文档一个缺少依赖的删除 update。XML 正文往返必须通过，不能只测 Y.Text 就宣布编辑器跨语言兼容。

- [ ] **Step 5: 验证并提交。** 运行 Python CRDT 测试、`npm --prefix frontend run test:interop` 和 `npm --prefix frontend run typecheck`，预期全部通过；锁定实际安装版本后提交 `chore: establish editor runtime and CRDT interoperability`。此时不宣称完成双端同步。

## Task 2: 可恢复、可去重的 SQLite 文档日志

**Files:** 创建 `backend/app/store.py`、`backend/tests/test_store.py`、`backend/tests/conftest.py`。

**Interfaces:** 实现第 2.2 节的 SqliteStore；消费 Task 1 生成的初始 CRDT update。`TxPayloadMismatch`、`DocumentNotFound`、`StorageUnavailable` 是 store 模块定义的明确异常。

- [ ] **Step 1: 写持久化去重失败测试。** 临时数据库必须在 tmp_path 下；用第二个 SqliteStore 实例模拟重新加载，不能复用内存缓存。

```python
import uuid
import pytest
from app.crdt import new_document
from app.store import SqliteStore, TxPayloadMismatch

def test_retry_is_durable_and_idempotent(tmp_path):
    path = tmp_path / "collab.db"
    store = SqliteStore(path)
    meta = store.create_document(new_document().get_update())
    tx_id = str(uuid.uuid4())
    first = store.append(meta.document_id, tx_id, b"payload-one")
    retry = SqliteStore(path).append(meta.document_id, tx_id, b"payload-one")
    assert retry.seq == first.seq
    assert retry.duplicate
    rows = SqliteStore(path).load_updates(meta.document_id)
    assert sum(row.tx_id == tx_id for row in rows) == 1
    with pytest.raises(TxPayloadMismatch):
        store.append(meta.document_id, tx_id, b"payload-two")
```

store 测试中的任意 bytes 只验证存储；CRDT 有效性由 Room 在写入前校验。运行对应 pytest 文件，首次因 store 缺失失败。

- [ ] **Step 2: 实现建表与连接策略。** 每次操作独立创建和关闭 sqlite3 连接，设置 foreign_keys=ON、busy_timeout=1000、synchronous=FULL；初始化时使用 WAL。路径父目录由应用创建，不把数据库提交到 Git。

```sql
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS updates (
  document_id TEXT NOT NULL REFERENCES documents(id),
  tx_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload BLOB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  PRIMARY KEY (document_id, tx_id),
  UNIQUE (document_id, seq)
);
```

- [ ] **Step 3: 实现原子写入。** create_document 用 `uuid.uuid4()` 和 UTC ISO 时间，在同一个 SQLite 事务插入文档及序号 0 的种子 update。append 使用 BEGIN IMMEDIATE，先查文档、再按去重键查原记录；摘要相同返回原 seq，摘要不同抛 TxPayloadMismatch。新记录取 next_seq，插入后 next_seq 加一，最后 commit；任何错误 rollback。lookup 同样检查摘要，load_updates 固定按 seq 升序。所有参数都使用 SQL 占位符。

关键事务控制必须保持如下顺序：

```python
try:
    connection.execute("BEGIN IMMEDIATE")
    result = append_in_transaction(connection, document_id, tx_id, payload)
    connection.commit()
except BaseException:
    connection.rollback()
    raise
finally:
    connection.close()
return result
```

`append_in_transaction` 是同一模块私有函数，不自行提交，内容如下：

```python
import hashlib

def append_in_transaction(connection, document_id: str, tx_id: str, payload: bytes) -> Receipt:
    digest = hashlib.sha256(payload).hexdigest()
    document = connection.execute(
        "SELECT next_seq FROM documents WHERE id = ?", (document_id,)
    ).fetchone()
    if document is None:
        raise DocumentNotFound(document_id)
    previous = connection.execute(
        "SELECT seq, payload_sha256 FROM updates WHERE document_id = ? AND tx_id = ?",
        (document_id, tx_id),
    ).fetchone()
    if previous is not None:
        if previous[1] != digest:
            raise TxPayloadMismatch(tx_id)
        return Receipt(tx_id=tx_id, seq=previous[0], duplicate=True)
    seq = document[0]
    connection.execute(
        "INSERT INTO updates(document_id, tx_id, seq, payload, payload_sha256) VALUES (?, ?, ?, ?, ?)",
        (document_id, tx_id, seq, payload, digest),
    )
    connection.execute("UPDATE documents SET next_seq = ? WHERE id = ?", (seq + 1, document_id))
    return Receipt(tx_id=tx_id, seq=seq, duplicate=False)
```

- [ ] **Step 4: 补齐故障验证。** 覆盖不同文档相同 txId 不串数据、写事务失败后没有半条记录、文档不存在不会隐式创建、两个连接竞争提交获得唯一序号、加载所有日志后重新构建 CRDT 一致。SQLite 写锁测试使用真实第二连接 BEGIN IMMEDIATE，捕获 busy_timeout 对应错误后释放锁，不使用 sleep 猜测。

- [ ] **Step 5: 通过 `backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/tests/test_store.py -q` 后提交 `feat: persist document updates with durable transaction receipts`。**

## Task 3: 文档 API、串行房间与 WebSocket 提交

**Files:** 创建 `backend/app/protocol.py`、`backend/app/room.py`、`backend/app/main.py`、`backend/tests/test_protocol.py`、`backend/tests/test_websocket.py`。

**Interfaces:** 消费 SqliteStore、CRDT 适配函数和共享消息契约；产出 `create_app(database_path, hooks=None) -> FastAPI`。HTTP 为 `POST /api/documents` 返回 201 和 `{documentId, createdAt}`、`GET /api/documents/{documentId}` 返回同结构或 404、`GET /api/health` 返回 `{status: 'ok'}`；WebSocket 为 `/ws/documents/{documentId}`。main.py 同时导出供 Uvicorn 使用的 `app = create_app(Path(os.environ.get('COLLAB_DB_PATH', 'backend/data/collab.db')))`，创建数据库及恢复资源置于 lifespan 内，导入模块不连接或修改数据库。

- [ ] **Step 1: 写接口与错误边界测试。** 使用 FastAPI TestClient 的 lifespan context 和 websocket_connect，验证先 hello 后 sync、错误 v、非法 UUID、非法 Base64、越界更新、未知字段、路径 documentId 与消息不一致、缺失文档、非 hello 首帧均被拒绝。每个连接绑定一个 syncId，后续帧不得切换。

```python
from fastapi.testclient import TestClient
from app.main import create_app

def test_unknown_document_is_not_created(tmp_path):
    with TestClient(create_app(tmp_path / "test.db")) as client:
        result = client.get("/api/documents/00000000-0000-4000-8000-000000000001")
        assert result.status_code == 404

def test_create_document_is_persistent(tmp_path):
    path = tmp_path / "test.db"
    with TestClient(create_app(path)) as client:
        created = client.post("/api/documents")
        assert created.status_code == 201
        document_id = created.json()["documentId"]
    with TestClient(create_app(path)) as client:
        assert client.get(f"/api/documents/{document_id}").status_code == 200
```

- [ ] **Step 2: 实现 Room 加载和 join。** room manager 单次创建房间，防止两个并发请求加载两个内存副本。每个 Room 有 asyncio.Lock、恢复好的 Doc 和 Peer 集合。在同一锁内登记 Peer 并把 sync 放入其 outgoing，然后才释放锁；sync 包含当前差量、state vector 和最高 seq。不在锁内等待网络发送，writer 从 FIFO 取消息发送。

- [ ] **Step 3: 实现提交、确认和屏障。** 在 Room 锁内先 lookup 去重；新操作在 candidate_document 上应用并检查完整状态大小，再通过 `asyncio.to_thread(store.append, ...)` 持久化，提交成功后替换正式 Doc。广播 update 后加入 ACK；重复 txId 只返回原 ACK。`barrier` 在锁内向 Peer 队列加入 ready。WebSocket handler 使用 shield 等待 Room 提交，单个浏览器断开不能在数据库提交途中取消房间任务。房间异常进入不可用状态并从日志重建，失败期间拒绝新写入。

```python
async with self.lock:
    receipt = await asyncio.to_thread(self.store.lookup, self.document_id, tx_id, payload)
    if receipt is None:
        candidate = candidate_document(self.doc, payload)
        if len(candidate.get_update()) > MAX_UPDATE_BYTES:
            raise UpdateTooLarge()
        receipt = await asyncio.to_thread(self.store.append, self.document_id, tx_id, payload)
        await self.hooks.after_commit(self.document_id, receipt.tx_id, receipt.seq)
        self.doc = candidate
        self.broadcast_update(payload, receipt.seq)
    self.enqueue_ack(peer, receipt)
```

`UpdateTooLarge` 在 protocol.py 定义；`broadcast_update`、`enqueue_ack` 是 Room 的同步入队方法，使用接收者自己的 syncId 构造消息。`after_commit` 是 Hooks 的异步扩展点，生产默认返回 None；测试可在此等待事件门控。写盘失败或候选验证失败不得走到广播和 ACK。

- [ ] **Step 4: 验证真实服务语义。** 两个 WebSocket 连接在同一文档握手并提交真实 CRDT 更新，验证另一方收到广播；收到 ACK 后通过另一 SQLite 连接查到对应记录。新增数据库失败不 ACK、重复 payload 不重复日志、握手期间 commit 无漏更新、慢 Peer 被关闭但其他 Peer 可继续、客户端离开释放订阅的测试。

- [ ] **Step 5: 运行后端完整 pytest；通过后提交 `feat: add durable WebSocket document synchronization`。** 此检查点可用独立 WebSocket 客户端验证，不依赖 Vue 页面。

## Task 4: IndexedDB 恢复日志与可靠保存状态

**Files:** 创建 `frontend/src/collab/journal.ts`、`frontend/src/collab/save-state.ts`、`frontend/tests/journal.test.ts`、`frontend/tests/save-state.test.ts`。

**Interfaces:** 实现第 2.3 节 Journal、`openJournal()`、`deriveSaveState(input: SaveInputs): SaveState`；消费 Y.Doc 和原始 V1 更新，不依赖 DOM 或 WebSocket。

- [ ] **Step 1: 写确认后仍可恢复的失败测试。** Vitest 使用 fake-indexeddb 模拟 API，但后续还必须在真浏览器复验。

```ts
import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { expect, test } from 'vitest'
import { openJournal } from '../src/collab/journal'

test('ACK clears pending status but preserves recovery data', async () => {
  const journal = await openJournal(crypto.randomUUID())
  const source = new Y.Doc()
  source.getText('probe').insert(0, '恢复中文🙂')
  const tx = await journal.appendLocal('doc-a', Y.encodeStateAsUpdate(source))
  await journal.acknowledge('doc-a', tx.txId)
  expect(await journal.pending('doc-a')).toEqual([])
  const restored = new Y.Doc()
  await journal.restore('doc-a', restored)
  expect(restored.getText('probe').toString()).toBe('恢复中文🙂')
  journal.close()
})
```

- [ ] **Step 2: 实现统一本地日志。** IndexedDB 创建 `updates` object store，使用 `{keyPath: 'order', autoIncrement: true}`；添加 `by-document`（documentId）与 `by-transaction`（[documentId, txId]，unique=true）索引。新记录插入时不手动赋 order；数据库填入自增主键。remote 记录的 txId 为 null，不进入复合键索引及待确认队列。请求 success 仅代表单个请求完成，Promise 必须在 transaction complete 后 resolve，abort/error 后 reject。appendLocal 复制原始 Uint8Array，产生稳定 txId；acknowledge 只更新确认字段；restore 使用 by-document cursor 的主键顺序 applyUpdate，使用 `RESTORE_ORIGIN`。

```ts
export const RESTORE_ORIGIN = Symbol('restore')
export const REMOTE_ORIGIN = Symbol('remote')

export function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener('complete', () => resolve(), { once: true })
    tx.addEventListener('abort', () => reject(tx.error ?? new Error('IndexedDB aborted')), { once: true })
    tx.addEventListener('error', () => reject(tx.error ?? new Error('IndexedDB failed')), { once: true })
  })
}
```

事务完成监听必须在执行请求之前注册。浏览器源站所有标签页使用数据库分配的顺序，不能以 Date.now 或本地递增变量排序。自增主键就是 JournalRecord.order。数据库升级或另一标签页阻塞打开时显示恢复失败及重试，不能永久停留在恢复中。

- [ ] **Step 3: 实现纯函数状态规则。** 错误不得被网络连接事件覆盖；远端 ACK 到达但本地确认标记尚未持久化时仍不是 saved。

```ts
export function deriveSaveState(s: SaveInputs): SaveState {
  if (s.localError) return 'local-error'
  if (s.remoteError) return 'remote-error'
  if (!s.restored) return 'restoring'
  if (s.localWrites > 0) return 'saving-local'
  if (!s.connected || !s.ready || s.unacknowledged > 0) return 'local-only'
  return 'saved'
}
```

- [ ] **Step 4: 补齐隔离和失败测试。** 未 ACK 记录重新打开后 txId 和 bytes 完全相同；同一文档的多个活动 Y.Doc 身份不同；不同文档 restore 不串内容；事务 abort 不报告本地保存；remote 与 restore 不产生发送事务；ACK 未知 txId 不误删除其他记录。

- [ ] **Step 5: 运行 `npm --prefix frontend test -- tests/journal.test.ts tests/save-state.test.ts`，通过后提交 `feat: preserve local updates and explicit save states`。**

## Task 5: 客户端握手、重连和原样重试

**Files:** 创建 `frontend/src/collab/protocol.ts`、`frontend/src/collab/provider.ts`、`frontend/tests/provider.test.ts`。

**Interfaces:** 消费 Journal、共享 wire types 和 Task 3 服务；实现 CollabProvider。公开测试事件只描述状态与 txId，不在正常界面暴露内部对象。

- [ ] **Step 1: 先写发送顺序的失败测试。** 注入 FakeSocket 和可控制 Promise 的 Journal：本地存储未 complete 前发送帧数不增加；存储成功后只能发送原始 bytes；ACK 超时后的 txId 和 payload 与首次完全相同。另验证旧 WebSocket 对象的消息和旧定时器不影响新 syncId。

- [ ] **Step 2: 实现单条有序入站链和持久化链。** 每个 Y.Doc 本地 update 在回调当下增加待保存计数，再排入持久化链，数据库 complete 后入发送队列。RESTORE_ORIGIN、REMOTE_ORIGIN 事件被识别并排除重新发送。入站 sync/update 先保留日志写入任务再应用文档；保存状态包含未完成的远端本地写入，失败保留可复制的内存文档。

```ts
let inbound = Promise.resolve()
socket.onmessage = (event) => {
  const message = decodeServerMessage(event.data)
  if (message.syncId !== activeSyncId) return
  inbound = inbound.then(async () => {
    if (message.syncId !== activeSyncId) return
    await handleServerMessage(message)
  }).catch(reportProtocolFailure)
}
```

`decodeServerMessage(data: unknown): ServerMessage` 负责运行时类型、版本和大小校验；`handleServerMessage` 是 provider 内部串行处理函数；`reportProtocolFailure(error)` 设置错误状态并关闭本连接，不静默吞掉失败。decode 的同步异常也必须由 onmessage 捕获并进入 reportProtocolFailure。异步步骤恢复时再次核对连接代次，旧连接遗留任务可以完成其已开始的本地持久化，但不得发送消息或改变新连接的 ready 状态。本地写入失败的原始 bytes 保留在内存重试队列，重试写入完成前不发送，不通过重新插入文本重建操作。

- [ ] **Step 3: 实现无缺口握手。** open 后发送 hello。收到 sync 后，按顺序应用并持久化服务端差量；在本地写入屏障完成后，基于服务端 state vector 生成 catchup update，使用新 txId 持久化并优先发送。收到 catchup ACK 后原样重发既有未确认批次，再进入普通 FIFO。catchup 的因果基线必须先于可能依赖旧更新的增量。每个连接同一时刻最多一个未 ACK 的上行 tx，以简化依赖和重试。

设握手开始排队时的最高本地序号为 B；catchup 及所有序号不大于 B 的事务完成确认后发送 `sync-end`，收到同 barrierId 的 ready 才设置 ready。B 之后的编辑照常排队，仍保持待保存状态。遇到删除更新不能用 state vector 相等跳过 catchup；可发送幂等的空更新，避免实现依赖二进制格式猜测。

- [ ] **Step 4: 实现 ACK 与重连。** ACK 将对应日志标记 confirmed，complete 后才推进 FIFO。ACK 超时默认 5 秒，关闭连接重新握手；重连延迟基数 500ms、翻倍上限 10 秒、随机抖动 0–250ms，成功 ready 后清零。暂时性存储错误保留队列并重连；永久协议错误停止自动重试，显示原因。停止会话时取消 timer、卸载 listener、关闭 socket、等待已捕获本地写入链结束；不能在异步持久化完成前销毁待保存状态。

- [ ] **Step 5: 增加可控时序测试。** 使用 fake timers 和 Promise gate 验证：仅删除的 catchup 不丢、ACK 在断开后到达不串会话、握手期间新编辑不被 ready 误标 saved、catchup ACK 后旧 tx 安全重发、重复 ACK 幂等、存储失败不清空队列、重连不会重复安装 Y.Doc listener。FakeSocket 的 send 数据保存后由测试逐条交付，不依赖真实时间 sleep。

- [ ] **Step 6: 运行 `npm --prefix frontend test -- tests/provider.test.ts tests/save-state.test.ts` 和 typecheck，通过后提交 `feat: recover collaborative sessions across disconnects`。**

## Task 6: Vue 文档入口和 DOM 编辑界面

**Files:** 创建 `frontend/src/documents/api.ts`、`frontend/src/documents/session.ts`、`frontend/src/editor/extensions.ts`、`frontend/src/editor/EditorPane.vue`、`frontend/src/App.vue`、`frontend/src/main.ts`、`frontend/src/styles.css`、`frontend/playwright.config.ts`、`frontend/e2e/fixtures.ts`、`frontend/e2e/editor.spec.ts`。

**Interfaces:** 消费 openJournal、CollabProvider、REST 元数据接口；产出 openDocumentSession 和可操作页面。使用 `#/documents/{documentId}` 链接，避免需要服务器提供任意前端路径回退。

- [ ] **Step 1: 建立浏览器运行夹具并写用户路径的失败测试。** 此任务先由 playwright.config.ts 的 webServer 启动真实应用后端（8001）和 Vite（5174），workers=1、reuseExistingServer=false；COLLAB_DB_PATH 指向 Node mkdtempSync 创建的临时目录，COLLAB_BACKEND_URL 指向 127.0.0.1:8001。fixtures.ts 提供两个独立 browser.newContext，各自 page，测试后关闭 context；不启用跨标签页本地广播。打开首页，点击“新建文档”，URL 出现 documentId，编辑器具有 `role=textbox`、`aria-label=文档正文`。输入中文、英文、emoji，刷新后正文仍在。测试使用可访问角色定位，不依赖 CSS nth-child。首次运行应因页面未实现而失败。Task 7 在此基础上替换为可控故障后端，不能等到 Task 7 才让本任务的浏览器测试可运行。

- [ ] **Step 2: 实现最小编辑扩展。** 使用 Document、Paragraph、Text、HardBreak、Collaboration，全部来自同一已锁定 Tiptap 3 系列。不启用 StarterKit 的普通历史，也不启用未在首版范围的 marks、图片或列表。纯文本粘贴通过编辑器 transaction 插入，按换行创建段落，不使用 innerHTML；粘贴携带 HTML 时仍取剪贴板 text/plain。

```ts
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import HardBreak from '@tiptap/extension-hard-break'
import Collaboration from '@tiptap/extension-collaboration'
import type { Doc } from 'yjs'

export function editorExtensions(doc: Doc) {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    Collaboration.configure({ document: doc, field: 'body' }),
  ]
}
```

正文组件通过 `useEditor` 和 EditorContent 挂载；editorProps.attributes 配置角色和 aria 属性，撤销重做调用编辑器 commands。没有协作初始数据且离线时显示无法载入，不能先生成另一份默认段落。

- [ ] **Step 3: 实现 session 生命周期。** 首先 restore 日志；若已有正文根结构，允许离线挂载，否则等待首次 sync 带来服务器种子。恢复后再监听本地更新；卸载或切换文档时先取消视图订阅，再 close session。API 请求失败显示可理解的错误并可重试；不能凭空创建 URL 指定的缺失文档。

- [ ] **Step 4: 实现界面和状态文案。** 首页仅提供新建和粘贴文档链接；编辑页提供复制链接、撤销、重做、正文、连接状态和保存状态。文案固定为“正在恢复本地内容”“正在保存到本地”“已保存到本地，等待同步”“服务端已保存”“本地保存失败”“服务端保存失败”。错误状态提供重试与复制文本，复制失败时选中可复制的纯文本展示框。调试详情默认折叠，仅显示最近 100 条连接、txId、ACK 事件，避免无限累积。

- [ ] **Step 5: 验证 DOM 操作和协作历史。** 先测单人输入、退格、Delete、Enter、Shift+Enter、跨段选中删除和纯文本粘贴，再双端验证；焦点保持在当前编辑器，远端更新不能整段重置本地选区。undo 后验证远端文字仍保留，redo 后双方再次收敛。

- [ ] **Step 6: 运行前端单测、typecheck、build 和 editor.spec.ts，通过后提交 `feat: deliver the collaborative document editing interface`。** 此检查点开始提供可打开的本地双端 Demo。

## Task 7: 故障门控与跨浏览器恢复验收

**Files:** 创建 `backend/tests/e2e_server.py`、`frontend/e2e/recovery.spec.ts`；修改已在 Task 6 创建的 `frontend/playwright.config.ts`、`frontend/e2e/fixtures.ts`、`frontend/e2e/editor.spec.ts`，以及后端集成测试。

**Interfaces:** e2e_server 使用 create_app 注入 ControlledHooks，仅测试入口装载控制路由；正常 app.main 不挂载控制路由。Playwright fixture 启动真实 Python 子进程和真实 Vite，保存独立临时 SQLite 路径并可用同一路径重启后端。

- [ ] **Step 1: 建立事件门控。** 定义 `after_commit`、`before_sync_send`、`before_ack_send` 三个服务器 hook；测试可 arm、wait、release，匹配 documentId、txId 或 syncId。门控用 asyncio.Event，wait 请求有明确 10 秒失败超时，释放由测试显式调用，不使用固定 sleep。控制服务仅监听 127.0.0.1，每次测试生成 token 并通过请求头校验；入口放在 tests 中。

```python
import asyncio

class Gate:
    def __init__(self):
        self.entered = asyncio.Event()
        self.released = asyncio.Event()

    async def hold(self):
        self.entered.set()
        await self.released.wait()

    async def wait_until_entered(self):
        await asyncio.wait_for(self.entered.wait(), timeout=10)

    def release(self):
        self.released.set()
```

`after_commit` 在 Room lock 内，可用于崩溃窗口；`before_sync_send`、`before_ack_send` 在连接 writer 内，不能持有 Room lock，否则无法测试握手期间另一方提交。

- [ ] **Step 2: 实现测试夹具。** 后端进程管理从 Playwright webServer 移到 fixtures.ts，webServer 仅保留 Vite；每个测试使用独立临时数据库，workers=1 避免端口及故障门控共享。`BackendProcess.start(databasePath)` 启动测试服务器并等待 /api/health；`kill()` 必须终止进程而不是调用应用清理流程；`restart()` 使用同一数据库；`gates.arm(point, match)` 返回 gateId，`gates.wait(gateId)` 等 entered，`gates.release(gateId)` 放行。浏览器支持两个独立 context 和同 context 双页两种场景。离线刷新测试只关闭或拦截 WS，保留 HTTP 页面资源可加载。fixtures 在 finally 中关闭其自己启动的子进程，清理路径前验证位于对应临时根目录中。

- [ ] **Step 3: 写丢 ACK 与崩溃测试。** A 提交后在 before_ack_send 等待，真实查询 SQLite 确认 txId 已存在，再断开 WS；重连检查原 txId 与 payload 被重发，记录数仍为 1，文本不重复。after_commit 暂停时 kill Python，随后同数据库重启，用全新浏览器读取文档，证明恢复不依赖原浏览器补传；原客户端再重试仍只有一条记录。

- [ ] **Step 4: 写握手和离线删除测试。** 暂停 A 的 sync writer，B 连续提交并等待 ACK，再释放 A；最终内容包含全部更新。A 同时编辑时验证 ready 不覆盖待保存状态。离线 A 只删除既有文本，检查删除前后 state vector 相同，恢复 WS 后 B 仍得到删除；不能用插入换行等额外操作掩盖缺陷。

- [ ] **Step 5: 写本地持久化与失败测试。** 等 IndexedDB complete 后刷新，保持 WS 断开，先检查正文和原 txId 恢复，再联网验证合并；已 ACK 内容同样测试离线刷新。用浏览器原生事务 abort 产生本地写入失败；用真实 SQLite 写锁产生服务端保存失败，验证 UI 不误显示已保存且修改仍在，释放故障后可以恢复。

- [ ] **Step 6: 写真并发和隔离测试。** 两端在同一基线上暂停上行，各自在相同位置插入后放行，验证双方新增文字都存在且最终结构一致。覆盖插入与删除交叉、同源双标签页活动客户端 ID 不同、不同文档隔离、远端更新期间本地选区、退出会话后无残留发送。

- [ ] **Step 7: 运行全套 pytest、Vitest 和 Playwright。** Playwright 首版使用 Chromium，workers=1，测试进程路径和数据库由 fixture 独立管理。预期所有已实现自动验收通过，超时打印 syncId、txId、seq 与保存状态用于诊断，不能靠增大超时掩盖丢消息。通过后提交 `test: cover concurrent editing and recovery fault windows`。

## Task 8: 中文输入、启动脚本和演示材料

**Files:** 创建 `scripts/dev.ps1`、`scripts/verify.ps1`、`README.md`、`docs/demo.md`、`docs/manual-ime-checklist.md`。

**Interfaces:** 消费上述稳定的命令、接口和页面；不增加新产品功能。

- [ ] **Step 1: 写可复现启动说明和脚本。** dev.ps1 检查项目虚拟环境和 node_modules，缺失时打印精确安装命令后退出；默认绑定 127.0.0.1。后台辅助进程使用 Start-Process -WindowStyle Hidden 并记录其 PID，退出时只清理自己启动的子进程。不按端口杀死未知进程。README 同时提供两个终端手动启动方法：

```powershell
# 终端一，项目根目录
backend/.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

```powershell
# 终端二，项目根目录
npm --prefix frontend run dev -- --host 127.0.0.1
```

运行时配置环境变量 `COLLAB_DB_PATH`，默认 `backend/data/collab.db`；测试覆盖该值到临时目录。应用只启动一个 worker，不宣称多进程房间一致性。

- [ ] **Step 2: 实现有失败即退出的验证脚本。** 按顺序执行 Python pytest、Vitest、typecheck、build 和 Playwright；每个命令后检查 LASTEXITCODE。完整验证命令如下，脚本不得把后续成功退出码覆盖前面失败：

```powershell
backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/tests -q
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run test:e2e
```

- [ ] **Step 3: 编写并执行五分钟演示。** 使用两个独立浏览器会话，依次演示创建及共享、同段并发、断线编辑及恢复、保存状态、原样重试与服务重启。每一步写清触发操作、可见结果和对应测试；讲解 CRDT 合并、Yjs transaction、应用 txId、SQLite transaction 的区别。

- [ ] **Step 4: 建立真实输入法验收表。** 字段为日期、操作系统、浏览器及版本、输入法及版本、组合输入步骤、远端操作、实际结果、是否通过、证据位置。覆盖拼音组合阶段收到远端插入、远端删除附近文字、候选词上屏、撤销重做及跨段选区。仅在实际操作后填写通过；没有系统输入法验证条件时标记“未执行”，列为已知验证限制，不用 fill 或合成 composition 冒充人工通过。

- [ ] **Step 5: 提交 `docs: add setup demo and input method validation guide`。** README 明确库与自研边界、单进程和受控环境限制、离线内容恢复与离线加载页面的区别；只记录实际执行结果。

## Task 9: 收尾核验与交付

**Files:** 仅修正本计划覆盖范围的缺陷；更新 README 和验证记录。

**Interfaces:** 消费 Task 1–8 的可运行产物；产出可审阅代码、验证证据和启动地址。

- [ ] **Step 1: 自查设计覆盖。** 对照下面矩阵，确认每项有代码和相应证据，不能以单测全绿替代双浏览器和持久化恢复验证。
- [ ] **Step 2: 运行完整 scripts/verify.ps1。** 对发现的问题走系统化排查，补能复现问题的回归测试，修复后只重跑受影响检查及最终必要全套；不无依据反复运行已通过测试。
- [ ] **Step 3: 检查交付 diff。** 执行 git diff --check、git status；检查无数据库、虚拟环境、密钥、截图临时文件或测试产物进入版本控制。确认 Python 锁文件与 npm 锁文件均已提交。
- [ ] **Step 4: 整理交付。** 给出项目位置、启动方式、测试结果、尚未执行的真实输入法项目和已知限制。只有可实际运行的 Demo 才报告其地址；公开部署与远程推送按用户后续要求处理。

## 3. 设计覆盖矩阵

| 设计要求 | 实现任务 | 核验位置 |
| --- | --- | --- |
| Vue + Python，DOM 编辑内核 | 1、6 | typecheck、build、editor.spec.ts |
| Document → Paragraph → Text、唯一初始化 | 1、3、6 | test_crdt.py、首次双端进入测试 |
| 同段并发输入与增删 | 1、3、5、6、7 | interop.test.ts、editor.spec.ts |
| 换行、合并、跨段删除、纯文本粘贴 | 6 | editor.spec.ts |
| 本地日志、刷新恢复、同源标签页 | 4、5、7 | journal.test.ts、recovery.spec.ts |
| 落盘后 ACK、幂等与稳定 txId | 2、3、5、7 | test_store.py、ACK 丢失测试 |
| 断线重连、删除-only 差量 | 1、5、7 | interop.test.ts、provider.test.ts、recovery.spec.ts |
| 握手订阅无空档、旧会话隔离 | 3、5、7 | test_websocket.py、provider.test.ts、门控握手测试 |
| 服务端崩溃与重启恢复 | 2、3、7 | 真进程终止后恢复测试 |
| 本地与服务端存储失败 | 2、4、5、7 | 原生 IDB abort、真实 SQLite 写锁测试 |
| 保存状态准确 | 4、5、6、7 | save-state.test.ts、UI 故障断言 |
| 撤销重做、选区、输入法 | 6、7、8 | editor.spec.ts、人工输入法记录 |
| 文档隔离和错误反馈 | 2、3、4、6、7 | 协议、store、journal 与双文档测试 |
| 启动、锁定依赖、演示和设计解释 | 1、8、9 | README、锁文件、演示与最终验证 |

## 4. 计划自审规则

执行前再次检查任务接口名称与第 2 节一致、所有验收项能映射到任务、测试失败是预期行为而不是环境错误。依赖元数据核对不等于实际互通通过；Task 1 的跨语言测试是选型进入后续实现的检查点。

接口声明不代表已完成实现，预计结果不代表测试记录。验收事实只能记录到实际运行后的验证材料中。
