# 给 Claude 的精简重构任务

请按以下新方案重构现有协同编辑器：

1. [设计方案](superpowers/specs/2026-09-23-fastapi-library-collaboration-design.md)
2. [实施计划](superpowers/plans/2026-09-23-fastapi-library-collaboration.md)

2026-09-21 的旧设计/计划仅供历史参考；其中自研 ACK、事务日志与握手状态机要求已被替代。

## 可以直接作为任务提示词的内容

请在现有 Vue + Python 协同编辑器代码上实施精简重构，遵循上述 2026-09-23 设计与计划。保留 FastAPI、Tiptap/ProseMirror、Yjs，同步使用 y-websocket + pycrdt-websocket，服务器保存使用 pycrdt-store/SQLite，本地保存使用 y-indexeddb。保留两人同段同时输入、离线编辑、刷新恢复、服务端恢复与基础 Undo/Redo。

目标是减少我们维护的协议与状态，而非增加封装层。替换并删除旧自研 provider、事务队列、ACK、重放、握手屏障、手写 IndexedDB 日志；不要在新库之外再建一套相同机制。连接/初始同步事件不能显示成“服务端已保存”。

实施代码位于 `F:\基于DOM的协作编辑器\.claude\worktrees\confident-mclaren-506b7a`，原分支 `claude/confident-mclaren-506b7a`，基线提交 `ecd7433`。根目录 `F:\基于DOM的协作编辑器` 的 main 只有文档。开始先核实 git 状态，不要在 main 再写一份应用。

注意：protocol.ts 有未提交的用户注释修改，删除旧模块前保存仓库外副本与补丁。旧 SQLite 文件与浏览器缓存也须保留，新版使用独立 v2 命名空间；不要自动清空、覆盖或迁移。

先做锁定版本的最小互通/持久化验证，再按五个任务替换后端、客户端、界面及测试。修复并回归验证快速切换文档串会话、复制正文丢失 Shift+Enter 换行的问题。保留有意义的行为测试，移除旧协议专用测试，不靠删断言让测试通过。

完成后提供实际工作树/提交、删除和保留的核心模块、运行命令、测试结果、真实中文输入法验收状态，以及保存/离线边界。不要把未运行的测试写成已通过。默认使用 UTF-8。

## 本次交接状态

- 技术方向和保留离线恢复已由用户确认。
- 新依赖的官方资料与发布元数据已核对；新架构尚未安装、运行或验收。
- 本次仅更新设计与交接文档，没有修改应用源码。
