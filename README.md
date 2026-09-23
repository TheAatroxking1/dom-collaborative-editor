# 基于 DOM 的协同编辑器

两个浏览器打开同一个文档链接，在同一段文字里同时编辑；断线可以继续写，刷新不丢内容，
服务端重启后已写入的内容仍在。

**架构一句话**：Vue / Tiptap 操作同一个 Y.Doc，`y-websocket` 负责网络，`y-indexeddb`
负责本地缓存；FastAPI 接入 `pycrdt-websocket`，`pycrdt-store` 负责服务端持久化。
应用只管理文档目录和资源生命周期，不实现同步协议，也不维护事务队列。

- 前端：Vue 3 + TypeScript + Vite，编辑内核 Tiptap / ProseMirror
- 协作：Yjs 13（Python 侧 pycrdt）
- 同步：`y-websocket` 3.1.0 ↔ `pycrdt-websocket` 0.16.5，标准 Yjs 二进制协议
- 持久化：`pycrdt-store` 0.1.5 / SQLite；浏览器侧 `y-indexeddb` 9.0.12

设计与计划见 [`docs/superpowers/specs/`](docs/superpowers/specs/) 与
[`docs/superpowers/plans/`](docs/superpowers/plans/)（2026-09-21 的首版设计与自研协议路线
已被 2026-09-23 的精简方案替代）。演示步骤见 [`docs/demo.md`](docs/demo.md)，
本机与局域网运行见 [`docs/local-and-lan.md`](docs/local-and-lan.md)，
实际验收结果与未验证边界见 [`docs/offline-lan-validation.md`](docs/offline-lan-validation.md)。

## 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 24.x | 前端构建与测试 |
| Python | 3.12 | 后端运行时；`requirements.lock` 按 3.12 生成 |
| uv | 0.12+ | 创建虚拟环境与锁定依赖 |

## 安装

```bash
uv venv --python 3.12 backend/.venv
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

受限网络下无法从官方源下载时，可指向本机已有的浏览器：

```bash
set PLAYWRIGHT_CHROMIUM_PATH=C:\path\to\chrome.exe
```

## 启动

一键启动（脚本只管理自己创建的进程，不会按端口结束未知进程）：

```bash
pwsh -File scripts/dev.ps1
```

> **注意**：一键脚本会用 `taskkill /T /F` **强制结束**它启动的子进程，服务端不会执行
> 停机时的完整状态写入。它只适合日常开发。

需要**正常关闭**（会触发服务端写完整状态）时，用两个终端：

```bash
backend/.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8787
```

```bash
npm --prefix frontend run dev
```

在这个终端按 **Ctrl+C** 结束后端，uvicorn 会走正常关闭流程。前端开发服务器在另一个
终端，同样用 Ctrl+C。

**构建版**（一个进程同时提供页面、API 与 WebSocket，前台运行，Ctrl+C 正常停止）：

```bash
pwsh -File scripts/serve.ps1
```

需要先构建一次：`npm --prefix frontend ci` 然后 `npm --prefix frontend run build`。
默认地址 <http://127.0.0.1:5274>。构建版用 5274、开发版用 5273，两者分开是为了避免
已安装的生产 Service Worker 接管开发页面。**切换模式前先停掉另一个后端**——即使端口
不同，也不要有两个 Python 进程同时写同一个数据目录。

打开 <http://127.0.0.1:5273>，点「新建文档」，把地址栏里的链接复制到另一个浏览器
（或另一个浏览器配置文件）打开即可协作。**不要用同一窗口的两个标签页**——虽然也支持，
但看不到跨端同步的效果。

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
| `COLLAB_DATA_DIR` | `backend/data/v2` | 数据目录，里面放两个数据库文件 |
| `COLLAB_STATIC_DIR` | 未设置 | 设置后由同一进程提供该目录下的构建产物；未设置时只是 API/WS 服务 |
| `COLLAB_BACKEND_URL` | `http://127.0.0.1:8787` | Vite 开发代理指向的后端 |
| `COLLAB_DEV_PORT` | `5273` | Vite 开发服务器端口 |

只启动一个 Uvicorn worker；首版是少量文档的单进程演示，不支持多进程协作。

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

端到端测试会给每个用例启动独立的 Python 进程与临时数据目录，端口默认取 8791（后端）与
5473（前端），可用 `COLLAB_E2E_BACKEND_PORT`、`COLLAB_E2E_FRONTEND_PORT` 覆盖。

## 数据放在哪里

| 文件 | 内容 | 由谁管理 |
| --- | --- | --- |
| `backend/data/v2/documents.sqlite3` | 文档目录：`documentId` 与创建时间 | 应用自己（`backend/app/documents.py`） |
| `backend/data/v2/updates.sqlite3` | CRDT 更新 | 库（`pycrdt-store`） |

两者刻意分开：应用不读写库的内部表结构，库也不会碰文档目录。浏览器缓存使用
`dom-collab-v2:<documentId>` 作为数据库名，与旧版自研日志**不共享命名空间**。

新文档由服务端生成唯一的空段落种子，先写入 CRDT 存储，成功后才登记目录并返回链接；
失败的文档对客户端完全不可见，不会出现「能打开但正文是半初始化」的情况。

## 连接状态的含义

界面只显示三种状态，它们都**不是**保存凭证：

| 显示 | 实际含义 |
| --- | --- |
| 正在打开… | 正在校验文档并恢复本地缓存 |
| 正在连接… | WebSocket 尚未就绪 |
| 已连接 | WebSocket 已建立，初始同步已完成 |
| 连接中断，可继续编辑 | 网络断了；本地缓存内容仍可读写 |

**「已连接」不代表某次输入已经写入磁盘。** 库的 `synced` 事件说明初始内容已同步，
不说明之后的每一笔修改都已被服务端提交。因此界面不显示「服务端已保存」，也没有队列
长度、确认计数这类数字。若将来确实需要逐笔落盘回执，应单独立项，而不是把旧的
ACK / 屏障系统加回来。

服务端侧同理：库的写入是异步调度的（`stop` 也不能当作写入排空），所以正常停机时应用
会**额外做一次完整状态写入**，并给它 10 秒上限；失败会抛错并记录，不会谎报保存成功。

## 保存与丢失的边界

这套方案是「自动保存 + 本地缓存」，不是逐笔落盘回执。以下情况可能影响最新修改，
文档如实说明：

- 页面在本地写入完成前被强制结束（缓存写入是批量调度的）；
- 浏览器清除了站点存储；
- 设备磁盘故障；
- 服务端在异步写入完成前被强制结束（`taskkill /F`、断电）；
- 断网期间在**没有**本地缓存的新设备上打开文档——那里只有服务端的内容。

以下情况**已经覆盖**并有自动化用例：

- 断线期间继续编辑，重连后两端的修改都保留；
- 只断 WebSocket 时刷新，正文从本地缓存恢复；
- 服务端正常停机后，新的浏览器上下文仍能读到数据库内容；
- 服务端被强制结束进程后，此前已写入的内容仍能读到；
- 超过 100 次更新（库的检查点间隔）之后重启，内容完整；
- 存储不可用时创建文档返回 503，界面给出可操作提示，不无限 loading；
- 本地缓存不可用时明确报错并可重试，不会把正文清空成空文档。

## 旧数据

2026-09-21 的首版使用自研协议，数据放在 `backend/data/`（不是 `v2/`），浏览器缓存使用
另一套命名空间。新旧协议不兼容。

**旧数据库与旧浏览器缓存全部保留，不做自动删除，也不自动迁移。** 旧链接不会自动变成
新文档。如需沿用旧文档，需要另做一次显式迁移，不在本版本内。

## 核心文件

```text
backend/app/documents.py      文档目录（sqlite3）与服务端种子构造
backend/app/collaboration.py  库对象组装、先恢复再开放同步、停机写回
backend/app/main.py           应用工厂、lifespan、HTTP 与 WebSocket 路由、可选静态目录
frontend/src/documents/api.ts       HTTP 文档接口
frontend/src/documents/session.ts   三个库对象的生命周期与连接状态
frontend/src/documents/backup.ts    备份格式、校验、编解码与纯文本预览
frontend/src/documents/DocumentBackup.vue  导出、预览、打开原文档、确认合并
frontend/src/offline.ts       页面外壳缓存的注册与状态（不接触正文）
frontend/src/clipboard.ts     剪贴板能力检测与成功/失败结果
frontend/src/editor/EditorPane.vue  编辑器实例、剪贴板、撤销/重做
frontend/src/editor/extensions.ts   最小编辑 schema 与 Collaboration
frontend/src/App.vue                页面入口与路由（含打开代次）
backend/tests/uvicorn_launcher.py   仅测试使用的启动器，支持从标准输入请求正常停止
frontend/e2e/fixtures.ts            开发套件：每个用例独立的后端进程与浏览器上下文
frontend/e2e-production/fixtures.ts 生产套件：真实构建产物与 setOffline 离线验收
scripts/dev.ps1                     开发启动入口（强制结束语义）
scripts/serve.ps1                   构建版前台启动，支持显式 TLS，Ctrl+C 正常停止
scripts/verify.ps1                  有序运行全部自动验证（含生产套件）
```

不要指望在这些文件里找到：消息编解码、发送队列、事务标识、确认语义、握手屏障、
候选文档克隆、手写 IndexedDB 日志。这些要么由库承担，要么已经删除。

## 已知限制

- **单进程、受控环境**：一个 Python 进程管理所有文档房间，只监听回环地址。链接即权限，
  没有账号与访问控制。公开部署前需要单独设计权限、访问限制与运维。
- **无远端光标、无在线名单、无历史版本**：首版范围之外。
- **撤销范围**：刷新页面后保留正文，但不保留上一会话的撤销栈。
- **离线页面缓存**：构建版会缓存页面外壳，整站断网后刷新仍能打开。但正文能否离线看到，
  取决于当前浏览器在当前地址下是否打开过该文档并写过本地缓存；首次访问必须联网。
  局域网 HTTP 不是安全上下文，完整离线刷新需要可信 HTTPS，见
  [本地与局域网运行指南](docs/local-and-lan.md)。
- **换地址不共享本地数据**：浏览器按 origin 隔离存储，改协议/主机名/端口后未同步的内容
  需要用页面底部的备份面板导出再导入。
- **不提供「立即更新」**：检测到新版本只提示，结束编辑后关闭全部页面重新打开才更新，
  避免自动刷新打断正在写的人。
- **pycrdt 索引式编辑**：pycrdt 0.14.5 的 `del text[a:b]` 按 Python 码点计数，与 Yjs 的
  UTF-16 码元不一致，在含非 BMP 字符（emoji 等）的文本上会误删或抛 Rust panic。
  真实客户端的编辑由浏览器里的 Yjs 完成，服务端只搬运二进制更新，因此不受影响；
  但**从 Python 直接按索引改正文是不安全的**。该边界记录在
  `backend/tests/test_library_integration.py` 的相应用例说明里。
- **中文输入法**：组合输入阶段的行为需要在真实系统输入法下人工验证，见
  [`docs/manual-ime-checklist.md`](docs/manual-ime-checklist.md)。该表尚未执行，不使用
  合成 composition 事件冒充人工通过。

## 与 2026-09-21 首版的区别

首版自研了 WebSocket 协议（JSON 信封 + Base64）、txId 去重、ACK 屏障、事务重放队列与
手写 IndexedDB 日志。这些都被替换成现成库：协议用标准 Yjs 二进制格式，去重与幂等由
CRDT 更新本身的幂等性承担，断线补齐由 `y-websocket` 的状态向量交换承担，本地缓存交给
`y-indexeddb`。

代价是放弃了「每次输入都经过数据库提交确认后才通知浏览器」这个语义。换来的是核心代码
大幅缩小：承担同步与保存职责的代码从约 1980 行（`provider.ts` 637、`room.py` 271、
`protocol.py` 254、`store.py` 252、`journal.ts` 249、`protocol.ts` 228、`save-state.ts` 44、
`crdt.py` 43）降到约 620 行（`collaboration.py` 288、`session.ts` 191、
`documents.py` 136），并且全部是可以逐行读完的库调用与生命周期管理。

当前整个应用源码（不含测试、样式与文档）约 1200 行。
