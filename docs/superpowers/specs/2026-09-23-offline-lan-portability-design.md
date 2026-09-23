# 离线打开、地址迁移与局域网兼容设计

日期：2026-09-23。状态：交给 Claude 实现的设计，尚未实现。

用户已确定：公开源码，提供本地和局域网运行指南；不要求在线演示。继续采用 Vue + Tiptap + Yjs + FastAPI，并允许两个人在同一段同时输入。本轮只处理已发现的三个边界，不重做同步和保存机制。

## 1. 当前起点

应用代码位于 `.claude/worktrees/confident-mclaren-506b7a`，核对起点提交为 `819669a`。仓库外层 main 目前主要存放方案；实现时必须进入包含 frontend/backend 的实际应用目录。下文路径均相对应用目录。

- 当前网页使用 hash 路由 `/#/documents/<UUID>`；WebSocket 地址随当前页面 origin 生成。
- 正文通过 `y-indexeddb` 保存在 `dom-collab-v2:<documentId>`；服务端通过 pycrdt-store 写 SQLite。
- 后端断线时可以继续编辑；已有正文可以从本地恢复。但前端静态资源没有 Service Worker，整站断网后刷新不能保证打开网页。
- 更换协议、主机名/IP 或端口后，浏览器使用另一份本地存储。
- HTTP 局域网下 Clipboard API 可能不存在；现有协作链接复制错误写入了只在首页显示的变量，文档页看不到失败提示。

此前已验证同机通过局域网 IP 访问和模拟弱网收敛；不等于已在第二台物理设备、可信 HTTPS 或完整离线环境完成验收。本轮不把这些情况标成已通过。

## 2. 方案取舍

| 方案 | 成本与效果 | 决定 |
| --- | --- | --- |
| 现成 SW 插件 + 手动备份迁移 + 复制降级 | 保留现有数据通路，补小而明确的能力 | 采用 |
| 账号、云备份、跨站桥接、自动迁移服务 | 增加后端、身份和数据生命周期，超出三个问题 | 不采用 |
| 只在 README 写限制 | 成本最低，但离线刷新和复制失败仍未解决 | 不采用 |

## 3. 全局约束

- UTF-8；一个 Uvicorn worker；保留 Vue/Tiptap/Yjs 与 FastAPI/pycrdt 库组合。
- 正文继续仅由 Yjs、y-websocket、y-indexeddb、pycrdt-store 处理；不新增 ACK、事务队列、重放日志、正文 HTTP 保存接口。
- 保留 `body` 根、现有 paragraph/text/hardBreak schema、`dom-collab-v2:` 缓存前缀、现有 SQLite 数据。
- `connected`、`synced` 和页面缓存完成都不表示正文已持久化到服务器。
- 页面只部署在域名/地址根路径；不增加子路径、GitHub Pages 或公网部署方案。
- 不手动清除用户文档缓存或数据库；允许 Workbox 正常淘汰旧版静态资源缓存。不升级无关依赖，不修改现有粘贴、中文输入和撤销重做行为。
- GitHub 交付是源码及说明；不执行推送，不自动配置证书信任、防火墙或公网端口。

## 4. 边界一：整站离线后仍能打开已使用的文档

### 4.1 只缓存网页资源

增加固定版本 `vite-plugin-pwa@1.3.0`，采用 `generateSW`，由 Workbox 预缓存构建后的 index.html、JS、CSS 和实际使用的本地资源。`manifest: false`，本轮不增加安装应用、图标和安装引导。

- 仅生产构建启用；Vite 开发模式不注册 SW。
- 不缓存 API、WebSocket、文档正文；`runtimeCaching: []`。
- 导航 fallback 只允许 `/` 和 `/index.html`，包含其查询参数；不把 `/api/*`、`/ws/*`、缺失资源或任意路径变成 HTML。
- 固定文档链接可收藏；离线首页继续使用现有“打开已有文档链接”。不新增文档列表或第二份正文索引。
- 本地没有正文时，离线打开必须说明无法获取正文，不能初始化空文档假装成功。
- 本地缓存保留与恢复仍使用现有 session；不把编辑器挂载到尚无 body 根的 Doc 上。

### 4.2 版本更新不打断编辑

使用 prompt 模式，禁止 autoUpdate、skipWaiting 和自动刷新。注册回调 `onNeedReload` 也只显示提示，不调用 reload；不要假设 prompt 配置本身足以禁止所有刷新。

提示：“新版本已准备好。结束编辑后，关闭本应用的所有页面再重新打开即可更新；需要保留一份副本时可先导出备份。”不增加“立即更新”按钮，不自建所谓保存 ACK 来决定何时刷新。

缓存提示只描述“页面资源已缓存”；另行说明只有当前浏览器、当前地址下已有正文的文档才能离线恢复。首次访问必须联网，浏览器清理站点数据后需要重新缓存。

### 4.3 一个可实际运行的生产入口

FastAPI 增加可选 `static_directory`，仅设置 `COLLAB_STATIC_DIR` 时提供构建产物。未配置时仍是原 API/WS 服务，不要求 dist 存在。

使用 StaticFiles 的路径解析和响应，在现有 API/WS 路由之后增加仅 GET/HEAD 的静态入口；拒绝 api/ws 前缀，无全站 HTML 回退。index.html、sw.js 和非哈希静态资源采用 `Cache-Control: no-cache`；`assets/` 下构建哈希资源可 immutable。

新增 `scripts/serve.ps1`：默认 `127.0.0.1:5274`，前台运行一个 Uvicorn worker，支持显式 HostAddress、Port、CertFile、KeyFile。开发版仍使用 5273，构建版使用另一 origin，避免已安装的生产 SW 接管开发页面；仅 devOptions.enabled=false 不能消除该问题。Ctrl+C 走正常停机；不复制 dev.ps1 的强制结束进程树逻辑。不使用 Vite preview 作为交付运行服务。

切换开发/构建运行模式时先停止旧后端，即使端口不同，也不同时运行两个写入同一 COLLAB_DATA_DIR 的 Python 进程。原开发地址上尚未同步的内容先导出再迁移。

本机 loopback HTTP 可以使用 SW。其他设备访问的 HTTP 局域网地址没有该例外，完整离线刷新需要可信 HTTPS。指南使用 mkcert 手动生成匹配实际 IP/主机名的证书，在访问设备信任该 CA 的公钥证书，再用 Uvicorn TLS 提供同源 HTTPS/WSS。证书不可信时应修正信任关系，不用浏览器忽略证书或不安全 origin 开关冒充支持。

HTTP 局域网模式仍可在线协作、在已打开页面里断线编辑、导出备份和手动复制；界面说明当前地址不能启用离线页面缓存。不要承诺普通 HTTP LAN 完整离线刷新。

## 5. 边界二：改变访问地址时迁移未同步内容

浏览器同源隔离不能被应用取消。采用固定入口地址 + 显式文件备份迁移。

### 5.1 文件契约

下载文件名为 `<documentId>-<时间>.collab-backup.json`。文件结构：

```ts
type DocumentBackupV1 = {
  format: 'dom-collab-backup'
  version: 1
  schema: 'paragraph-text-hardbreak-v1'
  documentId: string
  exportedAt: string
  sourceOrigin: string
  updateBase64: string
}
```

`updateBase64` 是 `Y.encodeStateAsUpdate(liveDoc)` 的完整二进制结果，包括本地未同步的插入和删除；不使用纯文本、HTML、ProseMirror JSON 或仅 state vector 替代。

文件最大 8 MiB，解码后的 update 最大 4 MiB。导出超过限制时明确报错；不要产生无法被本程序重新导入的文件。不读取其他 origin 的 IndexedDB。

### 5.2 先检查，再由用户合并

一个持续挂载的备份面板提供：导出当前正文、选择文件、只读文本预览、打开原文档、合并备份。

1. 选择文件先检查大小、JSON、格式/版本/schema、规范 UUID、日期、来源 origin、严格 Base64 和解码大小。
2. 在临时 Y.Doc 的 body 根应用 update；必须得到至少一个合法 paragraph，内部只允许无属性/格式标记的 text 和 hardBreak；拒绝额外共享根、非法节点及解码异常。临时对象 finally 销毁，预览按纯文本渲染。
3. 文件来自另一 documentId 时，不向当前文档应用。用户先点击“打开原文档”，通过现有 hash 路由打开文件标识。面板保留文件；路由变化不会自动导入。
4. 用户点击“合并备份”时，要求当前会话已可编辑且 documentId 匹配。以当前 origin 的 GET `/api/documents/<id>` 校验存在性，8 秒超时；await 后再检查文件和 session 身份没变。
5. 使用 `Y.applyUpdate(currentSession.doc, update, 'backup-import')`。复用已有本地保存和 WebSocket 通路；同一备份重复导入不重复插入。

`sourceOrigin` 仅展示，不用于发请求或自动跳转。导入错误不替换当前正文、不删除缓存、不自动创建新文档。网络错误允许重试；404 提示当前服务器没有原文档，同时保留预览供手动复制到用户自己新建的文档。

本轮保证的是**同一服务器数据下换地址、端口或设备**的迁移。更换空数据库、搬到另一台无原文档的服务器，不能靠客户端文件自动重建文档目录；用户可从预览复制正文，或另行备份迁移完整服务端数据。

备份导入是 CRDT 合并，不是历史回滚。较早备份不会保证撤销后来的删除。也不把原文档 CRDT update 应用到另一份已独立初始化的新文档，避免重复种子和混合历史。

## 6. 边界三：复制功能在 HTTP 局域网和拒绝授权时可用

共享一个轻量 `tryCopyText(text): Promise<boolean>`，只在安全上下文且 API 存在时尝试 `navigator.clipboard.writeText`。成功后显示“已复制”；不支持或被拒绝时，就地显示只读 input/textarea，让用户选中后 Ctrl+C 或长按复制。

协作链接的降级字段必须出现在文档页按钮附近。正文复制复用相同 helper，但保留现有正文序列化、换行及手动 textarea；不为复用而重写 EditorPane 的粘贴和选区处理。不使用 execCommand 或要求用户改浏览器安全选项。

## 7. 验收映射

| 编号 | 必须证明的行为 | 实施任务 |
| --- | --- | --- |
| B1 | 可选静态目录；API/WS 正常；不存在路径 404；缓存头正确 | Task 1 |
| B2 | 构建版先联网后整站断网刷新，页面来自 SW，原正文与离线修改恢复 | Task 2 |
| B3 | 未缓存正文不造空文档；API/WS 不命中 HTML/正文缓存 | Task 2 |
| B4 | 两个编辑页遇到新版本均不自动刷新；关闭全部页面后可更新 | Task 2 |
| B5 | 更换 origin，导出/导入同 UUID，离线插入和删除均迁移并收敛 | Task 3 |
| B6 | 重复导入无重复；错误格式/大小/内容、错 ID、404、超时和切页不污染当前正文 | Task 3 |
| B7 | 剪贴板成功、API 缺失、权限拒绝时均有正确可见反馈 | Task 4 |
| B8 | 第二台设备通过可信 HTTPS 协作、离线刷新和恢复；HTTP 降级说明属实 | Task 5 |
| B9 | README 无个人绝对路径；运行指南完整；数据、证书私钥和用户备份不提交 | Task 5 |
| B10 | 原有测试、中文输入/粘贴/撤销行为不退化 | 各任务、Task 5 |

自动验收必须使用真实生产构建和 `context.setOffline(true)`，不能只切断后端或拦截 WebSocket。双设备/证书信任/中文输入未实测的条目必须标记“未验证”，不能从 localhost 测试推导通过。

## 8. 官方依据

- [插件 1.3.0 依赖范围](https://github.com/vite-pwa/vite-plugin-pwa/blob/v1.3.0/package.json)：包含 Vite 8；仅确认元数据兼容，仍需本项目构建验收。
- [SW 策略](https://vite-pwa-org.netlify.app/guide/service-worker-strategies-and-behaviors)、[注册回调实现](https://raw.githubusercontent.com/vite-pwa/vite-plugin-pwa/v1.3.0/src/client/build/register.ts)：生成 SW 与更新行为依据。
- [Workbox 构建配置](https://developer.chrome.com/docs/workbox/modules/workbox-build)、[Playwright SW 测试](https://playwright.dev/docs/service-workers)：预缓存与真实浏览器验证。
- [IndexedDB 同源隔离](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)、[安全上下文](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)、[Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard)：地址和 HTTP 能力边界。
- [Yjs updates](https://docs.yjs.dev/api/document-updates)：完整 update 编解码与幂等合并。
- [Starlette StaticFiles](https://starlette.dev/staticfiles/)、[mkcert](https://github.com/FiloSottile/mkcert)：静态服务与本地可信证书。Uvicorn TLS 参数同时核对了本项目安装的 0.53.0 CLI help。
- [GitHub Pages 范围](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)：静态托管不承载本项目 Python/WebSocket 后端。
