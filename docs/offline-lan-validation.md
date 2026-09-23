# 离线与局域网验收记录

日期：2026-09-23
核对起点提交：`819669a`
运行环境：Windows 11 Pro 22631、Node 24.15.0、Python 3.12.4、Chromium 149.0.7827.55（Playwright）

**这份记录只写实际执行过的结果。** 自动测试通过不等于所有环境都通过；未实测的项目单独列出，
不拿自动结果推导。

## 一、自动验收结果

全部来自一次 `pwsh -File scripts/verify.ps1` 运行（退出码 0）。

| 套件 | 数量 | 结果 | 命令 |
| --- | ---: | --- | --- |
| 后端单元与集成 | 53 | 通过 | `python -m pytest -c backend/pyproject.toml backend/tests -q` |
| 前端单元 | 42 | 通过 | `npm --prefix frontend test` |
| 前端类型检查（含生产套件） | — | 通过 | `npm --prefix frontend run typecheck` |
| 前端构建 | — | 通过 | `npm --prefix frontend run build` |
| 端到端（开发模式） | 41 | 通过 | `npm --prefix frontend run test:e2e` |
| 端到端（生产构建版） | 25 | 通过 | `npm --prefix frontend run test:e2e:production` |

生产套件用的是真实构建产物与真实 Python 进程，**没有 Vite dev，也不通过拦截 WebSocket
冒充离线**。

### 边界一：整站离线后仍能打开已使用的文档

| 验证内容 | 用例 | 结果 |
| --- | --- | --- |
| 断网后整页刷新，页面来自 Service Worker | `offline.spec.ts` › 断网后整页刷新… | 通过 |
| 断网期间的新增在再次刷新后仍在 | 同上 | 通过 |
| 断网期间的删除在刷新后仍生效 | 同上 | 通过 |
| 恢复网络后与另一端收敛 | 同上 | 通过 |
| 页面已缓存但没有该文档正文时，不创建空编辑器 | `offline.spec.ts` › 页面已缓存但没有该文档的正文时… | 通过 |
| 离线接口请求失败，不返回页面外壳 | `offline.spec.ts` › 离线时接口请求失败… | 通过 |
| CacheStorage 中没有 API 与 WebSocket 响应 | `offline.spec.ts` › 缓存里没有 API 与 WebSocket 响应 | 通过 |
| 全新上下文离线首次访问不声称可用 | `offline.spec.ts` › 全新上下文从未访问时… | 通过 |
| 两个编辑页遇到新版本都不自动刷新 | `offline.spec.ts` › 两个编辑页遇到新版本… | 通过 |
| 关闭全部页面后重新打开，新版本生效 | 同上（断言服务的是版本 B 的构建标记、没有 worker 仍在等待） | 通过 |
| 重开后正文来自本地缓存 | `offline.spec.ts` › 重开后正文来自本地缓存… | 通过 |
| 开发模式不注册 Service Worker | `e2e/navigation.spec.ts` › 开发模式不注册 Service Worker | 通过 |
| 开发模式说明缓存只在构建版启用 | `e2e/navigation.spec.ts` › 开发模式说明… | 通过 |
| 生产构建版不显示「只在构建版启用」的提示 | `offline.spec.ts` › 生产构建版下不显示… | 通过 |
| 当前地址不支持离线缓存时，文档页也说明 | `offline.spec.ts` › 地址不支持离线缓存时… | 通过 |

判定「页面来自 SW」用的是 `response.fromServiceWorker()`，不是仅看页面是否能渲染。

### 边界二：改变访问地址时迁移未同步内容

两个 origin（`http://127.0.0.1:5483` 与 `http://localhost:5483`）指向**同一个** Python 进程，
因此「服务端数据相同、浏览器存储隔离」这个前提是真实的。

| 验证内容 | 用例 | 结果 |
| --- | --- | --- |
| 离线插入与删除都随备份迁移 | `backup.spec.ts` › 离线插入与删除都随备份迁移… | 通过 |
| 重复导入同一备份不重复插入 | 同上 | 通过 |
| 与目标端的并发编辑收敛 | 同上 | 通过 |
| 刷新后内容仍在 | 同上 | 通过 |
| 备份属于另一个文档时不写入当前正文 | `backup.spec.ts` › 备份属于另一个文档时… | 通过 |
| 非法 JSON / 格式 / UUID 被拒绝且不影响正文 | `backup.spec.ts` › 损坏或不支持的备份被拒绝… | 通过 |
| 结构合法但数据损坏的备份被拒绝 | 同上 | 通过 |
| 服务端没有该文档时保留预览、不自动新建 | `backup.spec.ts` › 服务端没有这份文档时… | 通过 |
| 校验超时明确失败、不写入正文 | `backup.spec.ts` › 合并前的在线校验超时… | 通过 |
| 校验期间切换文档时不写入新文档 | `backup.spec.ts` › 校验期间切换文档时… | 通过 |
| 离线仍可导出与预览 | `backup.spec.ts` › 离线时仍可导出与预览… | 通过 |
| 连续换文件时先选的那份不覆盖后选的那份 | `backup.spec.ts` › 连续换文件时… | 通过 |
| 清除选择后仍在读取的结果不回来 | `backup.spec.ts` › 清除选择后… | 通过 |
| 编解码层单测（含删除迁移、emoji、结构校验） | `frontend/tests/backup.test.ts`（15 项） | 通过 |

### 边界三：复制在 HTTP 局域网和拒绝授权时可用

| 验证内容 | 用例 | 结果 |
| --- | --- | --- |
| 安全上下文下自动复制成功 | `clipboard.spec.ts` › 安全上下文下自动复制成功 | 通过 |
| 非安全上下文显示可手动复制的完整链接 | `clipboard.spec.ts` › HTTP 局域网（非安全上下文）… | 通过 |
| 缺少 Clipboard API 时同样降级 | `clipboard.spec.ts` › 浏览器缺少 Clipboard API 时… | 通过 |
| 权限被拒绝时同样降级 | `clipboard.spec.ts` › 权限被拒绝时… | 通过 |
| 切换文档后复制反馈重置 | `clipboard.spec.ts` › 切换文档后复制反馈会重置 | 通过 |
| 正文复制的成功与降级 | `clipboard.spec.ts` › 正文复制（2 项） | 通过 |
| 能力检测单测 | `frontend/tests/clipboard.test.ts`（7 项） | 通过 |

**这一组是能力分支的模拟**：非安全上下文与权限拒绝通过 `addInitScript` 构造。
真实局域网设备上的复制行为仍需人工确认，见下面「未验证」。

### 原有行为未退化

| 验证内容 | 用例 | 结果 |
| --- | --- | --- |
| 中文/emoji 输入、刷新恢复 | `e2e/editor.spec.ts` | 通过 |
| 粘贴（纯文本、拆段、段落中间） | `e2e/editor.spec.ts`（4 项） | 通过 |
| 跨段选区删除、软换行 | `e2e/editor.spec.ts` | 通过 |
| 协作撤销不撤销远端内容 | `e2e/editor.spec.ts` | 通过 |
| 断线编辑、离线删除传播、服务重启恢复 | `e2e/recovery.spec.ts`（13 项） | 通过 |
| 文档切换竞态 | `e2e/navigation.spec.ts` | 通过 |

## 二、未验证的项目

以下项目**没有实际执行**。不要把它们当作已通过。

### 1. 第二台真实设备 + 可信 HTTPS

**未验证。** 本轮只有一台机器，没有生成证书，也没有在第二台设备上访问过。

缺少的条件与可执行步骤（完整版见 [本地与局域网运行指南](local-and-lan.md)）：

1. 两台设备接入同一网络，确认能互相 ping 通；
2. 在服务端执行 `mkcert -install`，然后用 `mkcert -cert-file .local-certs/lan.pem
   -key-file .local-certs/lan-key.pem localhost 127.0.0.1 <你的IPv4>`（把地址换成实际值）；
3. `mkcert -CAROOT` 找到根目录，把 `rootCA.pem` 装到**第二台设备**并信任；
4. `pwsh -File scripts/serve.ps1 -HostAddress 0.0.0.0 -Port 5274 -CertFile .local-certs/lan.pem -KeyFile .local-certs/lan-key.pem`；
5. 第二台设备打开 `https://<你的IPv4>:5274`，确认地址栏无证书警告、`window.isSecureContext` 为 true；
6. 验证：双人同段输入 → 一台断网 → 编辑与删除 → **整页刷新** → 内容仍在 → 恢复网络 → 两端收敛。

预期结果不应从本机的 localhost 测试推导，必须在第二台设备上重跑上面第 6 步。

### 2. HTTP 局域网下的真实复制行为

**未验证。** 自动用例覆盖的是能力分支（非安全上下文、API 缺失、权限拒绝），
但没有在真实的局域网 HTTP 地址上让另一个用户实际点过复制按钮。

步骤：在第二台设备上用 `http://<你的IPv4>:5274` 打开，点「复制协作链接」，
确认出现「请选中下方链接手动复制」与可手动选中的完整链接，并且链接里的地址是当前访问的地址。

### 3. 真实中文输入法

**未验证。** 见 [中文输入法人工验收表](manual-ime-checklist.md)，各项仍标记为「未执行」。
自动化里的 `keyboard.insertText` 与合成 composition 事件都会绕过输入法的组合阶段，
不能用来宣称输入法通过。

### 4. 其他未覆盖的边界

- **不同操作系统与浏览器**：只在 Windows 11 + Chromium 149 上运行过。
- **多进程部署**：只支持一个 Uvicorn worker，未设计也未验证多进程房间一致性。
- **强制结束时的最新修改**：`taskkill /F` 之后不保证最后一刻的输入已落盘。测试只断言
  「此前已写入的内容能恢复」。
- **大文档**：备份上限 8 MiB（解码后 update 4 MiB），未在大文档上验证。

## 三、复现方式

```bash
pwsh -File scripts/verify.ps1
```

`verify.ps1` 会依次跑后端 pytest、前端单测、类型检查、构建、开发套件与生产套件，
任一步失败立即以该步退出码结束。首次运行若缺浏览器：

```bash
npm exec --prefix frontend -- playwright install chromium
```

受限网络下可指向本机已有的 Chromium：

```bash
set PLAYWRIGHT_CHROMIUM_PATH=C:\path\to\chrome.exe
```
