# 基于 DOM 的协同编辑器

两个浏览器打开同一个文档链接，在同一段文字里同时编辑；断线可以继续写，刷新不丢内容，
服务端重启后已确认的修改仍然在。

- 前端：Vue 3 + TypeScript + Vite，编辑内核为 Tiptap / ProseMirror
- 协作：Yjs（CRDT）
- 后端：FastAPI + pycrdt，WebSocket 同步，SQLite 持久化
- 本地持久化：IndexedDB 统一更新日志

设计说明见 [`docs/superpowers/specs/2026-09-21-dom-collaborative-editor-design.md`](docs/superpowers/specs/2026-09-21-dom-collaborative-editor-design.md)，
实施计划见 [`docs/superpowers/plans/2026-09-21-dom-collaborative-editor.md`](docs/superpowers/plans/2026-09-21-dom-collaborative-editor.md)，
五分钟演示步骤见 [`docs/demo.md`](docs/demo.md)。

## 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 24.x | 前端构建与测试 |
| npm | 11.x | |
| Python | 3.12 | 后端运行时；`requirements.lock` 按 3.12 生成 |
| uv | 0.12+ | 创建虚拟环境与锁定依赖 |

## 安装

```bash
uv venv --python 'D:\Python\python.exe' backend/.venv
```

```bash
uv pip compile backend/requirements.in --python-version 3.12 --generate-hashes --output-file backend/requirements.lock
```

```bash
uv pip sync --python backend/.venv/Scripts/python.exe --require-hashes backend/requirements.lock
```

```bash
npm --prefix frontend install
```

端到端测试需要 Chromium：

```bash
npm exec --prefix frontend -- playwright install chromium
```

受限网络下无法从官方源下载时，可以指向本机已有的 Chromium，Playwright 会直接使用它：

```bash
set PLAYWRIGHT_CHROMIUM_PATH=C:\path\to\chrome.exe
```

## 启动

一键启动（脚本只管理自己创建的进程，不会按端口结束未知进程）：

```bash
pwsh -File scripts/dev.ps1
```

或者手动开两个终端：

```bash
backend/.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8787
```

```bash
npm --prefix frontend run dev
```

打开 <http://127.0.0.1:5273>，点“新建文档”，把地址栏里的链接复制到另一个浏览器
（或另一个浏览器配置文件）打开，即可开始协作。

默认端口是 8787（后端）与 5273（前端），刻意避开 5173 和 8000——这两个端口在开发机上
经常被其他项目或 Docker 占用。需要换端口时三处要一致：

```bash
backend/.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 9000
```

```bash
COLLAB_BACKEND_URL=http://127.0.0.1:9000 COLLAB_DEV_PORT=5300 npm --prefix frontend run dev
```

运行时配置：

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `COLLAB_DB_PATH` | `backend/data/collab.db` | SQLite 数据库路径 |
| `COLLAB_BACKEND_URL` | `http://127.0.0.1:8787` | Vite 开发代理指向的后端 |
| `COLLAB_DEV_PORT` | `5273` | Vite 开发服务器端口 |

## 测试

```bash
pwsh -File scripts/verify.ps1
```

按顺序执行后端 pytest、前端 Vitest、类型检查、构建和 Playwright，任一步失败立即以该步的
退出码结束。也可以单独运行：

```bash
backend/.venv/Scripts/python.exe -m pytest -c backend/pyproject.toml backend/tests -q
```

```bash
npm --prefix frontend test
```

```bash
npm --prefix frontend run test:e2e
```

端到端测试会为每个用例启动独立的 Python 进程与临时数据库，端口默认取 `8791`（后端）与
`5473`（前端），可用 `COLLAB_E2E_BACKEND_PORT`、`COLLAB_E2E_FRONTEND_PORT` 覆盖。
刻意避开 `8000/8001/5173`：开发机上它们常被其他服务占用，测试不应为此终止不属于自己的进程。

## 文档模型

一个应用文档对应一个 `documentId` 和一个 Y.Doc。正文是命名为 `body` 的 `Y.XmlFragment`，
通过官方编辑绑定映射为 ProseMirror 的 Document → Paragraph → Text。

创建文档时服务端只写入一次规范空段落并持久化这份共享种子；浏览器不会各自补一份默认正文，
因此不会出现重复初始化。首版不引入业务 Block ID，段落身份完全由 CRDT 维护。

SQLite 保存的是原始 CRDT 更新，不是 HTML 或 JSON 快照——只有可继续合并的更新才能在重连
和重启后继续参与合并。

## 同步与保存

自建的 WebSocket 传输层只搬运现成的 Yjs 更新，不实现新的合并算法。消息使用带协议版本与
类型字段的 JSON 信封，二进制字段为 Base64。

| 消息 | 方向 | 作用 |
| --- | --- | --- |
| `hello` | 客户端 → 服务端 | 携带本地状态向量，发起本轮同步 |
| `sync` | 服务端 → 客户端 | 返回服务端差量、状态向量与同步位置 |
| `tx` | 客户端 → 服务端 | 提交带唯一 `txId` 的更新或补同步差量 |
| `ack` | 服务端 → 客户端 | 确认指定 `txId` 的更新已持久化 |
| `update` | 服务端 → 客户端 | 广播已持久化的增量及服务端序号 |
| `sync-end` / `ready` | 双向屏障 | 确认本轮的同步事务处理完毕 |
| `error` | 服务端 → 客户端 | 报告协议、文档、数据或存储错误 |

服务端提交顺序固定为：去重 → 候选文档校验 → SQLite 事务提交 → 内存发布 → 广播与 ACK。
只有落盘成功才发送 ACK，因此客户端显示的“服务端已保存”有确切含义。

客户端保存流程固定为：本地输入先写入 IndexedDB，事务 `complete` 之后才允许发送。
界面文案与状态的对应关系：

| 状态 | 文案 |
| --- | --- |
| `restoring` | 正在恢复本地内容 |
| `saving-local` | 正在保存到本地 |
| `local-only` | 已保存到本地，等待同步 |
| `saved` | 服务端已保存 |
| `local-error` | 本地保存失败 |
| `remote-error` | 服务端保存失败 |

## 三种事务不是同一概念

- **Yjs transaction**：组织本地 CRDT 变更。
- **应用 txId**：标识可重试的传输批次；重试复用同一个 txId 与同一份字节。
- **SQLite transaction**：保证服务端更新日志与去重记录原子提交。

Yjs 更新幂等解决内容重复应用，txId 去重解决协议确认与持久化记录重复，数据库提交解决
保存承诺。三者各司其职，缺一不可。

## 库与本项目的边界

| 能力 | 来源 |
| --- | --- |
| 并发合并、删除传播、因果序 | Yjs / pycrdt |
| DOM 编辑、选区、输入法组合、撤销栈 | Tiptap / ProseMirror 与 Collaboration 扩展 |
| 应用界面与状态展示 | 本项目（Vue） |
| WebSocket 握手、重连退避、确认超时、原样重试 | 本项目 |
| 落盘后确认、txId 去重、服务端序号、房间串行化 | 本项目 |
| IndexedDB 更新日志、刷新恢复、保存状态聚合 | 本项目 |
| 故障门控与跨进程恢复验收 | 本项目（仅测试入口装载） |

## 为什么用 CRDT，以及为什么仍然需要 ACK

允许两个人在同一段里同时打字，就意味着不能靠“谁先提交谁赢”。段落锁会让第二个人写不进去，
版本校验后拒绝过期提交则要求用户自己处理被拒绝的修改。CRDT 让并发插入与删除自动收敛，
代价是需要在编辑内核之上再叠一层结构化编辑绑定。

CRDT 只解决“最终内容一致”，不解决“服务端到底存下来了没有”。WebSocket `send` 返回成功
只代表数据交给了内核缓冲区，浏览器崩溃、网络中断或服务端写盘失败都可能让它丢失。因此本项目
坚持在 SQLite 事务提交之后才发送 ACK，客户端也只有在收到 ACK 之后才显示“服务端已保存”。

## 已验证的故障场景

以下场景都有可重复执行的自动化用例，覆盖在 `backend/tests`、`frontend/tests` 与
`frontend/e2e` 中：

| 场景 | 用例位置 |
| --- | --- |
| 同段并发插入、增删交叉后各端一致 | `frontend/e2e/editor.spec.ts`、`frontend/e2e/recovery.spec.ts`、`frontend/tests/interop.test.ts` |
| 远端更新期间本端焦点与选区不被重置 | `frontend/e2e/editor.spec.ts` |
| 服务端提交成功但 ACK 丢失，重发后不重复插字、不重复建记录 | `frontend/e2e/recovery.spec.ts` |
| 提交后、广播前进程被杀，重启后新客户端仍能读到 | `frontend/e2e/recovery.spec.ts` |
| 握手期间另一端持续提交，无订阅空档 | `frontend/e2e/recovery.spec.ts`、`backend/tests/test_websocket.py` |
| 断线期间只做删除，重连后删除仍然传播 | `frontend/e2e/recovery.spec.ts`、`frontend/tests/provider.test.ts` |
| 断线刷新后先从 IndexedDB 恢复，再与服务端合并 | `frontend/e2e/recovery.spec.ts` |
| 服务端写锁导致保存失败，界面不误报已保存且内容不丢 | `frontend/e2e/recovery.spec.ts` |
| 浏览器本地写入失败，保留内容并允许重试 | `frontend/e2e/recovery.spec.ts`、`frontend/tests/journal.test.ts` |
| 慢连接被关闭而其他连接不受影响 | `backend/tests/test_websocket.py` |
| 不同文档之间更新、日志与确认互相隔离 | `backend/tests/test_store.py`、`frontend/e2e/editor.spec.ts` |
| 同源双标签页不产生身份冲突或重复正文 | `frontend/e2e/recovery.spec.ts` |
| 跨语言二进制互通（中文与 emoji） | `frontend/tests/interop.test.ts` |

## 已知限制

- **单进程、受控环境**：一个 Python 进程管理所有文档房间，只监听回环地址。链接即权限，
  没有账号与访问控制。公开部署前需要单独设计权限、访问限制与运维。
- **小文档**：单个更新上限 1 MiB，候选完整状态同样受此限制；客户端待发送内容超过 8 MiB
  时暂停新增编辑并保留已有记录。不宣称大文档能力。
- **日志不压缩**：已确认的更新保留在本地日志中，只用状态字段移出待发送队列。这样做是为了
  避免 ACK、日志清理与本地快照之间的崩溃窗口；后续压缩必须把快照提交与旧日志清理放在同一个
  本地数据库事务里。
- **撤销范围**：刷新页面后保留正文，但不保留上一会话的撤销栈。
- **完全离线加载**：本地恢复的前提是页面资源能够加载；首版不做离线应用资源缓存。
- **pycrdt 索引式编辑**：pycrdt 0.14.5 的 `del text[a:b]` 按 Python 码点计数，与 Yjs 的
  UTF-16 码元不一致，在含非 BMP 字符（emoji 等）的文本上会误删或抛 Rust panic。本项目的
  服务端只应用二进制更新、读取快照和编码状态，从不按索引编辑正文，因此不受影响；该边界记录在
  `backend/tests/test_crdt.py` 的模块说明中。
- **中文输入法**：组合输入阶段的行为需要在真实系统输入法下人工验证，见
  [`docs/manual-ime-checklist.md`](docs/manual-ime-checklist.md)。该表尚未执行，不使用合成
  composition 事件冒充人工通过。

## 目录结构

```text
backend/app/crdt.py         文档创建、克隆与候选校验
backend/app/store.py        SQLite 文档与更新日志
backend/app/protocol.py     协议校验、大小限制与错误码
backend/app/room.py         单文档串行提交、订阅与恢复
backend/app/main.py         FastAPI 工厂、HTTP 与 WebSocket 接口
backend/tests/e2e_server.py 仅测试进程装载的故障门控服务
frontend/src/collab/        协议编解码、IndexedDB 日志、同步 provider、保存状态
frontend/src/documents/     文档元数据接口与会话生命周期
frontend/src/editor/        编辑扩展与正文组件
frontend/src/App.vue        文档入口、编辑页面与状态展示
scripts/dev.ps1             开发启动入口
scripts/verify.ps1          有序运行全部自动验证
```
