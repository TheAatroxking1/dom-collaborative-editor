# FastAPI Library Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已指定由 Claude 实现；如执行环境没有这些技能，直接按本文顺序执行，不为安装技能阻塞任务。

**Goal:** 用现成库替换自研同步/保存机制，保留同段并发、离线编辑与刷新恢复，使核心代码容易独立 review。

**Architecture:** Vue/Tiptap 操作同一个 Y.Doc；y-websocket 负责网络，y-indexeddb 负责本地缓存。FastAPI 接入 pycrdt-websocket，pycrdt-store/SQLite 负责 CRDT 存储；应用仅管理文档目录和资源生命周期。

**Tech Stack:** Vue 3、Tiptap 3、Yjs 13、y-websocket、y-indexeddb、Python 3.12、FastAPI、pycrdt-websocket、pycrdt-store、SQLite、pytest/Vitest/Playwright。

## Global Constraints

- 默认采用 UTF-8；前端 Vue，后端 Python/FastAPI，一个 Uvicorn worker。
- 两个人必须能在同一段同时打字；保留离线编辑与本地刷新恢复。
- 使用标准 Yjs 二进制协议，不保留自研 ACK、txId、seq、syncId、握手屏障或补偿重放队列。
- connected/synced/whenSynced 不能表示数据库已保存；UI 不显示“服务端已保存”。
- 先恢复房间再开放同步，空段落种子仅由服务端创建一次。
- 不删除旧数据库、旧缓存、用户未提交修改；不把重构做成双协议长期兼容系统。
- 不引入 Node.js 后端、Redis、ORM、通用事件总线或插件架构。
- 不无条件升级现有前端依赖，不修改全局开发环境。

设计依据：[精简方案](../specs/2026-09-23-fastapi-library-collaboration-design.md)。该设计的 A1–A10 是验收依据。

> **执行状态（2026-09-23 补记）：** Task 1–5 已实施完成。最终验证：后端 pytest 33 项、
> 前端 Vitest 17 项、类型检查、构建、Playwright 端到端 31 项（覆盖 A1–A10）全部通过，
> `scripts/verify.ps1` 退出码 0。
>
> 与计划的偏差：
>
> - **`ASGIWebsocket` 没有从包顶层导出**，需从 `pycrdt.websocket.asgi_server` 取。
> - **store 的 `__aenter__`/`__aexit__` 必须成对在同一任务里执行**，否则 anyio 会拒绝
>   退出别的任务创建的取消作用域。房间是按连接按需创建的，因此改用低层
>   `start()`/`stop()` 并自己持有任务；这也让停机时的写入顺序完全可控。
> - **`create_sync_message` 等构造器产出的是含外层 `YMessageType` 的完整帧**，而
>   `handle_sync_message` 消费的是去掉外层字节的载荷，两者不能混用。
> - **库会把更新广播给发送者自己**，测试客户端需要吃掉这帧回流。
> - **控制台中断在 Windows 上是 CTRL_BREAK_EVENT**，不是 SIGINT；已验证它能触发
>   lifespan 收尾流程。测试用启动器因此改为持有 `uvicorn.Server` 并从标准输入
>   请求停止，不把任何停止控制放进正式路由。
> - **Playwright 的 `unrouteAll` 不覆盖 WebSocket 路由**，离线刷新用例改为用一个
>   常驻的 `routeWebSocket` 处理器加可控开关。
> - **Windows 剪贴板把 `\n` 规范化为 `\r\n`**，复制正文的断言需要先统一换行。
> - **pycrdt 0.14.5 的索引式删除在多字节文本上仍会误删或 panic**：测试里刻意只用
>   ASCII 构造删除用例，并在 README 与用例说明中记录该边界。

## 0. 起点与交付方式

实现根目录：`F:\基于DOM的协作编辑器\.claude\worktrees\confident-mclaren-506b7a`。先核实目录仍存在且含 frontend/backend；不要在只有文档的 main 目录另建一份应用。

从当前已完成代码重构，复用界面、schema、文档接口和用户行为测试。每个任务结束说明替换了什么、删除了什么、测试结果；按任务形成小提交。未提交用户修改先独立备份，不能与任务提交混在一起。

```powershell
git status --short
git log -1 --oneline
git diff -- frontend/src/collab/protocol.ts
```

先保存 protocol.ts 未提交修改到仓库之外的 UTF-8 补丁及文件副本，并记录路径。只做备份，不 stash、reset 或覆盖。

文档内的代码是公共边界与关键用法，不是整套现成实现。函数内部由 Claude 按固定版官方 API 实现；不要把计划扩展成新的协议框架。

## Task 1：锁定依赖，验证最小真实同步与持久化

**Files:** 修改 `frontend/package.json`、`frontend/package-lock.json`、`backend/requirements.in`、`backend/requirements.lock`；新增 `backend/tests/test_library_integration.py`、`frontend/tests/library-interop.test.ts`。

- [ ] 从官方 registry 核实发布版并锁定：npm 包 `y-websocket` 为 `3.1.0`、`y-indexeddb` 为 `9.0.12`；Python 包 `pycrdt-websocket==0.16.5`、`pycrdt-store==0.1.5`。保留 Yjs `13.6.32` 和一致的 Tiptap `3.31.3`；pycrdt 使用满足 `>=0.14,<0.15` 的固定补丁版，优先保留现有 `0.14.5`，如需 `0.14.6` 必须说明原因。
- [ ] 首先写一个真实通路测试：两个 Yjs 客户端连接测试 FastAPI 服务，使用 `body` XmlFragment，先由 Python 写种子，再输入中文/emoji/删除，比较内容；禁止用 mock 服务代替互通测试。
- [ ] 测试启动新库前应失败在缺失的新入口/依赖；实现最小适配后验证通过。再通过官方 store 恢复一个新的 Python Doc，比较正文，验证普通 shutdown 无未关闭任务/文件句柄错误。
- [ ] 正确使用新命名空间；不得照抄仍使用旧模块名的文档。下面仅表示导入与配对关系：

```python
from pycrdt import Doc
from pycrdt.websocket import WebsocketServer, YRoom
from pycrdt.store import SQLiteYStore, YDocNotFound
```

```ts
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence } from 'y-indexeddb'
```

- [ ] 使用现有项目虚拟环境安装，提交两个锁文件；不采用 Git main 依赖或 prerelease `@y/websocket`/Yjs 14。

```powershell
uv pip compile backend/requirements.in --python-version 3.12 --generate-hashes --output-file backend/requirements.lock
uv pip sync --python backend/.venv/Scripts/python.exe --require-hashes backend/requirements.lock
npm --prefix frontend install
backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/tests/test_library_integration.py -q
npm --prefix frontend test -- tests/library-interop.test.ts
```

**Review 条件：** 锁定组合确实互通并能恢复；若有库级阻碍，说明证据和最小调整，不退回自研网络协议。

2026-09-23 已核对发布元数据：[y-websocket 3.1.0](https://registry.npmjs.org/y-websocket/3.1.0)、[y-indexeddb 9.0.12](https://registry.npmjs.org/y-indexeddb/9.0.12)、[pycrdt-websocket 0.16.5](https://pypi.org/pypi/pycrdt-websocket/0.16.5/json)、[pycrdt-store 0.1.5](https://pypi.org/pypi/pycrdt-store/0.1.5/json)。这些只是可安装与约束依据，Task 1 的真实通路测试仍须执行。

## Task 2：替换 FastAPI 后端，保留薄接入

**Files:** 重写 `backend/app/main.py`；新增 `backend/app/documents.py`、`backend/app/collaboration.py`、`backend/tests/test_documents.py`、`backend/tests/test_collaboration.py`。

**公共边界：** 以下是职责接口，不要求额外创建抽象基类：

```python
from dataclasses import dataclass
from pycrdt.websocket import YRoom

@dataclass(frozen=True)
class DocumentMeta:
    document_id: str
    created_at: str

# documents.py: SQLite 目录，正文不在此维护。
# create_document() -> DocumentMeta
# get_document(document_id: str) -> DocumentMeta | None
# collaboration.py: 使用库对象；先恢复后返回。
# async get_ready_room(document_id: str) -> YRoom
# async close() -> None
```

- [ ] 先加 A1/A7/A8/A9 后端用例：唯一种子、未知 UUID、不重复建房间、旧状态恢复、写入失败、文档隔离、正常关闭。
- [ ] 目录只有 `documents(id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`。元数据用 sqlite3；库正文存储使用独立文件，避免直接依赖库的表结构。
- [ ] `POST /api/documents` 先写唯一种子，写入成功后登记目录并返回 201；失败 503。`GET` 保持原响应形状和 404 行为。
- [ ] 在 lifespan 管理 WebsocketServer、store 与 room；使用 `auto_clean_rooms=False`。单次恢复锁只保护新房间初始化，不参与每个编辑事务。
- [ ] FastAPI WS 路由规范化 UUID、验证目录，然后交给库处理二进制帧。拒绝分支先 accept 再 close(4404/1013) 以传递关闭码，但不创建房间；正常分支避免和 ASGIServer 重复 accept。优先使用库的 Channel/ASGI 适配；如需包装 FastAPI WebSocket，只实现 path/send/recv/迭代和断开转换，不解析 Yjs 消息。
- [ ] 将正文加载完成、room 启动、`ydoc_observed` 就绪都设为 serve 前置条件；`ready=False` 不会替你拦截 serve。已有目录却无可恢复状态返回存储错误。库 write 异常不得被“已处理”后静默忽略；使用 ASGIServer 时不要重复 accept。
- [ ] 关闭顺序：停止接客和消息处理 → await 各房间完整 CRDT 状态写入 → 关闭 room/store/server。等待上限 10 秒；失败必须可见，不谎报保存成功。
- [ ] 全部改动接通后删除旧 `backend/app/{protocol,room,store,crdt}.py`。删除针对旧 txId/ACK 语义的测试，保留/重写仍有用户意义的恢复、隔离和并发用例。

```powershell
backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/tests/test_documents.py backend/tests/test_collaboration.py backend/tests/test_library_integration.py -q
```

**Review 条件：** 后端只有文档 API、库生命周期与持久化接入；新客户端能通过真实 WS 编辑，独立恢复也得到相同正文。

## Task 3：用两个 provider 替换客户端状态机

**Files:** 重写 `frontend/src/documents/session.ts`；必要时调整 `documents/api.ts`；新增 `frontend/tests/session.test.ts`，替换旧 provider/journal/save-state 测试。

**给页面的边界：** 保留现有 `openDocumentSession` 名称，精简返回值；不暴露队列、事务与 provider 私有字段。

```ts
type ConnectionState = 'connecting' | 'connected' | 'disconnected'
// openDocumentSession(documentId: string): Promise<DocumentSession>
// DocumentSession 暴露 doc、canMountEditor、connection、error、retry()、close()。
// doc 为 Y.Doc；状态用 Vue ShallowRef；close() 返回 Promise<void>。
```

关键配对方式（归属同一会话，session 负责清理）：

```ts
const doc = new Y.Doc()
const local = new IndexeddbPersistence(`dom-collab-v2:${documentId}`, doc)
const network = new WebsocketProvider(wsBaseUrl, documentId, doc, {
  connect: false,
  disableBc: true,
})
// wsBaseUrl 指向 ws(s)://当前域名/ws/documents。
// 等本地恢复（带 10 秒超时），完成后 network.connect()。
// 禁止把 local.whenSynced 或 network 的 sync 事件映射为“已保存”。
```

- [ ] 默认关闭 BroadcastChannel，保证同源标签页的协作也经过 Python；离线恢复仍由每页的 y-indexeddb 承担。
- [ ] 先写生命周期单测：本地先恢复、恢复超时可重试、无种子不挂载、离线有缓存可挂载、重复关闭安全、缓存 destroy 未返回也能切换文档、关闭后不更新 UI、4404 停止重连。
- [ ] 网络事件只映射简单连接状态；`sync` 只用于首次就绪。网络失败不清空 Y.Doc；本地恢复失败不无限等待，也不覆盖已有缓存。
- [ ] 缓存加载后有 body 则可编辑；没有 body 且服务端不可达则显示等待，避免 Tiptap 自动产生第二份初始段落。
- [ ] 正常写入与重连使用库的路径；不再次为 Y.Doc update 分配 txId、先落盘再发送、编码 Base64 或维护 pending 字节数。
- [ ] 清理所有手动订阅，销毁网络/缓存 provider 与 Doc；不得使用 clearData。缓存清理超过 10 秒不得阻塞新路由，隔离旧回调并处理迟到结果。重试是重新建立资源或调用库公开连接方法，不是重放旧应用事务。
- [ ] 接入通过后删除 `frontend/src/collab/{provider,journal,protocol,save-state}.ts`。protocol.ts 用户修改先按 Task 0 备份；旧文件移除以新实现通过验收为前提。

```powershell
npm --prefix frontend test -- tests/session.test.ts
npm --prefix frontend run typecheck
```

**Review 条件：** session 是资源组装层，能逐段阅读而不必理解发送队列/握手阶段；A5/A6 的能力保留。

## Task 4：简化页面并修复已发现的交互问题

**Files:** 调整 `frontend/src/App.vue`、`frontend/src/editor/EditorPane.vue`、`frontend/src/editor/extensions.ts`、`frontend/src/styles.css`；更新 `frontend/e2e/editor.spec.ts`，新增 `frontend/e2e/navigation.spec.ts`。

- [ ] 用一个路由打开代次处理 A→B 竞态；旧异步结果被丢弃并关闭。编辑器实例按会话身份重新挂载，不把 B 的视图接到 A 的 session。
- [ ] 状态展示按设计第 3 节；移除“服务端已保存”、待确认数量、技术调试面板、队列超限引起的复杂暂停逻辑。
- [ ] 用编辑器公开的纯文本序列化能力复制正文，确保 HardBreak 变成 `\n`；剪贴板失败保留可选择复制的文本。
- [ ] 粘贴明确使用 text/plain。测试剪贴板里 text/plain 为 `纯文本`、text/html 为不同的 `HTML内容`，断言得到前者，避免旧测试两种内容相同而误通过。
- [ ] 保留段落、文本、HardBreak、Collaboration；不引入 StarterKit 的第二套历史。覆盖 Enter/Shift+Enter/跨段删除/本地 UndoRedo。
- [ ] 新增路由竞态用例：暂停 A 的恢复 → 打开 B → 释放 A，断言 URL、可见正文、复制正文、后续编辑目标都属于 B。
- [ ] 修正现有选区用例的时序：明确建立并检查 ProseMirror/DOM 选区后再继续操作；不靠增大 timeout 或删除断言变绿。

```powershell
npm --prefix frontend run test:e2e -- e2e/editor.spec.ts e2e/navigation.spec.ts
```

**Review 条件：** DOM 编辑与同段协作保留，页面能解释当前连接情况；之前串会话与复制丢换行的实际缺陷得到回归覆盖。

## Task 5：端到端验收、删除旧设施、交付说明

**Files:** 重写 `frontend/e2e/recovery.spec.ts`、简化 `frontend/e2e/fixtures.ts` 与必要的 `backend/tests/e2e_server.py`；更新 `README.md`、`docs/demo.md`、`docs/manual-ime-checklist.md`、`scripts/dev.ps1`、`scripts/verify.ps1`。

- [ ] 按设计 A1–A10 完成行为验收。并发用例先让两端从同一基线断开、分别修改，再重连；至少覆盖同位置插入、插入/删除交叉和纯删除。
- [ ] 用两个独立浏览器上下文验证真实 Python WS 路径；另测同源两页。不能仅凭共享缓存/广播成功就宣称后端同步成功。
- [ ] 离线刷新只断 WS、不阻断应用资源；刷新前通过独立缓存读取确认目标正文能恢复，不用 `whenSynced` 当逐更新写入回执。
- [ ] 服务重启恢复使用全新浏览器上下文，断开旧页面避免补传掩盖数据库缺失；覆盖超过 100 次更新、最后一个客户端退出后立即正常关闭的场景。测试启动器持有 `uvicorn.Server`，正常停止请求设置 `should_exit=True` 并等待进程退出，验证 lifespan 完成。Windows 的 `child.kill()` 仅用于独立崩溃用例；强制结束测试只要求恢复此前已验证写入的内容。
- [ ] 删除旧 ACK 丢失、同 txId 去重、syncId 屏障的测试及相关专用控制接口；保留正常恢复、存储故障与生命周期测试。故障注入仅用于测试，不进入生产路由。
- [ ] 检查没有遗留旧协议导入、第二套 IndexedDB 日志或手写 CRDT 候选克隆。仅用于历史文档的术语不计入残留代码。
- [ ] 更新 README：新架构、两份数据库位置、旧数据保留但默认不迁移、连接状态语义、缓存/崩溃边界。写清正常启动和关闭办法。
- [ ] 脚本继续只关闭自己创建的进程，后台进程使用隐藏窗口，不按端口终止未知服务；修正 README 中 PowerShell 环境变量示例。不要把 `taskkill /T /F` 称为正常停止。若一键脚本暂不能提供优雅退出，README 明示其强制结束语义，并提供后端独立终端 Ctrl+C 的正常关闭步骤；测试用停止控制不得进入正式应用的 HTTP 路由。
- [ ] 执行以下检查并记录实际数量/结果；中文输入法未实际操作则保持“未执行”。

```powershell
$env:PYTHONUTF8 = '1'
backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/tests -q
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run test:e2e
git diff --check
```

Playwright 缺浏览器时，安装项目要求的浏览器或显式设置 `$env:PLAYWRIGHT_CHROMIUM_PATH='C:/Program Files/Google/Chrome/Application/chrome.exe'`，记录实际使用的浏览器，不能把启动失败视为功能通过。

**最终交付必须包含：** 实际工作树/提交、变更后的核心文件清单、删除的旧协议模块、测试结果、真实 IME 状态、保存承诺边界和未迁移数据位置。正常打开两个浏览器、编辑同段、断线后恢复、正常重启恢复应能在五分钟内演示。

## Review 的判断标准

能否在只读 API、session 和库生命周期接入时理解整个流程？是否真正删除了应用级同步状态机？是否为每个自研状态都找到不可替代的用户需求？如果只是换了文件名、增加包装类或另写一套“轻量 ACK”，本次精简未达成。
