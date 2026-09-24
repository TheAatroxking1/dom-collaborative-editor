# Windows 一键安装实施计划

**目标：** 用户下载并解压源码后，双击 `install.bat` 安装依赖并构建，再用 `start.bat` 启动现有 5274 服务。

**方案：** BAT 只调用系统 Windows PowerShell 5.1；安装逻辑集中在 `scripts/install.ps1`，启动复用 `scripts/serve.ps1`。已有 Python 3.12 / Node.js 24 优先复用。缺 Node 时下载官方 ZIP 并核对 SHA256，保存到忽略的 `.tools`；缺 Python 时通过官方 Python Install Manager 安装 3.12，明确使用 `pymanager` 避免旧版 `py` 冲突。不要求 Git、uv、PowerShell 7 或 WinGet。

**约束：** 仅当前 PowerShell 进程使用 ExecutionPolicy Bypass；不修改系统策略、全局 PATH、防火墙或用户文档。官方安装器可能需要系统确认。缺失或错误虚拟环境不得靠删除用户目录来修复；每一步失败立即退出，保留日志。

## 实施与验收

- [x] 创建临时 PowerShell 5.1 行为测试：脚本不存在时失败；覆盖复用工具、pip / npm 失败停止、错误虚拟环境保留、中文空格路径。
- [x] 增加 `scripts/install.ps1`：工具探测、必要安装、创建虚拟环境、`ensurepip`、哈希锁依赖安装、npm ci/build、`install.log`。
- [x] 增加 `install.bat` / `start.bat`，检查退出码、工作目录和双击窗口保留。
- [x] README 添加 ZIP 下载与双击路线，保留手工安装和 macOS 指南；忽略 `.tools` / 日志，固定 BAT 为 CRLF。
- [x] 运行临时行为测试，并在独立源码副本中执行真实 pip/npm 安装与构建、启动后确认页面及 API 可访问。

发布步骤：核对 diff 后提交并推送 GitHub，以远端提交标识确认发布结果。

## 关键命令

安装环境后，主脚本执行现有流程：

```text
<Python 3.12> -m venv backend/.venv
backend/.venv/Scripts/python.exe -m ensurepip --upgrade
backend/.venv/Scripts/python.exe -m pip install --require-hashes -r backend/requirements.lock
<Node 24> <同目录 npm-cli.js> --prefix frontend ci
<Node 24> <同目录 npm-cli.js> --prefix frontend run build
```

无全新 Windows 虚拟机时，不能将下载校验、模拟安装分支或已有环境测试写成全新系统实测。安装程序不包含同步、编辑器或数据库逻辑变更。
