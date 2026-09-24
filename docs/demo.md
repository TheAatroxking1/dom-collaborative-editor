# 五分钟演示

演示目标：同段并发输入、文字与段落选区、批量操作、断线恢复。完整验证另见 [README](../README.md#测试)。

## 准备

按 [README](../README.md#快速开始windows) 安装依赖，然后从仓库根目录运行：

```powershell
npm --prefix frontend run build
powershell.exe -NoProfile -File scripts/serve.ps1
```

打开 <http://127.0.0.1:5274>，准备两个独立浏览器环境，例如 Chrome 与 Edge，或者普通窗口与隐私窗口。所有步骤都使用同一份文档的链接。

真实双设备演示时用 `-HostAddress 0.0.0.0` 启动，并统一访问服务电脑的局域网 IP；参见[局域网指南](local-and-lan.md)。不要向另一台设备分享 localhost 链接。

## 1. 创建与同段编辑

1. A 点击「新建文档」，输入「今天的会议记录」。
2. 点击「复制协作链接」，在 B 打开；HTTP 下复制失败时使用页面给出的链接手动复制。
3. 两端把文字光标放到同一段，各自输入不同的一句话。

预期：双方最终内容一致，两份输入都能保留；可以看到对方的访客名与文字光标。并发插入的先后顺序由 CRDT 确定，不等于键盘操作的墙钟时间顺序。

对应：`frontend/e2e/editor.spec.ts`。

## 2. 光标、选择与撤销

1. A 输入三个段落，在其中一段拖动选中文字，B 观察文字选区。
2. A 在段落内移动鼠标，B 观察远端指针。
3. A 从正文左侧留白拖动跨过两段，B 观察这两段的高亮。
4. A 点击「复制所选段落」，粘贴到别处检查顺序。
5. A 删除所选段落，然后 Ctrl+Z 或点击「撤销」。

预期：整批段落一次恢复，两端同步；选中段落不阻止 B 输入。普通正文拖动仍然选择文字。鼠标目前只在段落范围内显示，段间间距和正文下方剩余空白属于已记录的待扩展范围。

对应：`frontend/e2e/presence.spec.ts`、`paragraph-selection.spec.ts`。

## 3. 断线继续写与重连

1. 两端保持文档打开，在服务终端按 Ctrl+C，等待服务停止。
2. A 与 B 分别继续输入或删除不同内容。
3. 用同一数据目录重新运行 `powershell.exe -NoProfile -File scripts/serve.ps1`。

预期：断线时编辑仍可进行，重连后双方修改合并。光标、鼠标等临时状态不等于正文保存状态。

对应：`frontend/e2e/recovery.spec.ts`。在浏览器开发者工具里切换 Offline 不一定会关闭已建立的 WebSocket，因此只切这个开关不能证明“已断开协作连接”。

## 4. 确认服务端恢复

1. 两端连接正常并出现相同正文后，关闭这两个文档页面。
2. 在服务终端 Ctrl+C 正常停机，检查没有停机或保存错误，再重新启动。
3. 用全新的浏览器上下文打开原链接。

预期：没有本地缓存的新上下文仍能读取正文。强制终止的边界是“此前已写入的内容可恢复”，不保证刚显示的每一个字都已落盘。

对应：`frontend/e2e/recovery.spec.ts`、`frontend/e2e-production/shutdown.spec.ts`。

## 5. 可选：整站离线刷新与备份迁移

这部分需要额外时间，并且使用构建版。本机回环地址或可信 HTTPS 才支持页面离线缓存；普通局域网 HTTP 不提供这个保证。

1. 已联网打开文档并完成本地保存后，等待页面提示资源已缓存。
2. 用开发者工具 Offline 模式模拟页面资源离线，再刷新。
3. 在可编辑的离线正文里修改内容，通过「备份与迁移」导出备份。
4. 恢复网络，在另一个地址来源（例如 `http://localhost:5274`）打开原文档链接。
5. 选择备份、核对预览，再点「合并备份」。

预期：缓存过的页面与正文能在离线刷新后恢复；未缓存过的文档不能离线首次打开。备份合并保留 CRDT 的插入和删除，不是将文档回滚到导出时刻。目标服务器必须已有同一文档 ID。

对应：`frontend/e2e-production/offline.spec.ts` 与 `backup.spec.ts`。

## 讲解时可说明的设计取舍

| 能力 | 来源 |
| --- | --- |
| DOM 编辑、文字选区 | Tiptap / ProseMirror |
| 并发合并、协作历史 | Yjs / pycrdt、Tiptap Collaboration |
| 文字光标与文字选择共享 | CollaborationCaret / Awareness |
| WebSocket 同步、重连 | y-websocket / pycrdt-websocket |
| 本地缓存 | y-indexeddb |
| 服务端内容存储 | pycrdt-store / SQLite |
| 文档目录、资源生命周期、鼠标与整段交互 | 本项目 |

「已连接」是 WebSocket 状态，不是逐笔落盘回执。自动化覆盖也不替代真实系统中文输入法与真实双设备弱网验收；相关边界列在 README 中。
