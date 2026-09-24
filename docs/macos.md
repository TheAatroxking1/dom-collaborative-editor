# macOS 运行指南

从 GitHub 克隆后，在 macOS「终端」中运行以下命令。默认流程只需要 Git、Node.js 24.x 和 Python 3.12，不需要 PowerShell、uv 或 Docker。

## 准备环境

先检查工具是否可用：

```sh
git --version
node --version
npm --version
python3.12 --version
```

缺少工具时，按对应官方说明安装，然后重新打开终端：

- [Git for macOS](https://git-scm.com/install/mac)。
- [Node.js 下载](https://nodejs.org/en/download)：选择 24.x 和当前 Mac 的架构；npm 随 Node.js 安装。
- [Python for macOS](https://www.python.org/downloads/macos/)：选择 3.12 系列；已有 Homebrew 的用户也可按 [python@3.12](https://formulae.brew.sh/formula/python@3.12) 的说明安装。

`python3` 不一定是 3.12，因此示例明确使用 `python3.12`。后续直接调用虚拟环境内的 Python，无需 `source activate`，也无需 `sudo pip`。虚拟环境不能跨系统复制，目录规则见 [Python venv 文档](https://docs.python.org/3.12/library/venv.html)。

## 安装并启动

```sh
git clone https://github.com/TheAatroxking1/dom-collaborative-editor.git
cd dom-collaborative-editor

python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install --require-hashes -r backend/requirements.lock
npm --prefix frontend ci
npm --prefix frontend run build
sh scripts/serve.sh
```

每一步成功后再执行下一步。打开 **<http://127.0.0.1:5274>**，点击「新建文档」，再把协作链接发给另一个浏览器或局域网内的另一台电脑。默认接受局域网连接；分享条件见下一节。终端需要保持运行；按 **Control+C** 正常停止，并留意停机日志中的错误。

后续启动只需在仓库根目录执行 `sh scripts/serve.sh`，不需要 `chmod`。更新源码时先停止服务，重新执行前端 build 并重启服务；依赖文件变化后重新安装对应依赖。已有旧页面缓存时，结束编辑后关闭全部页面再重新打开。

不要从 Windows 复制 `.venv` 或 `node_modules`。Mac 的虚拟环境解释器是 `backend/.venv/bin/python`，Windows 的 `Scripts/python.exe` 路径在 Mac 上不适用。

## 局域网访问

`sh scripts/serve.sh` 默认监听所有 IPv4 网卡（`0.0.0.0:5274`），本机仍可访问 `http://127.0.0.1:5274`。
`0.0.0.0` 是监听地址，不是浏览器访问地址。只希望本机使用时，显式指定回环地址：

```sh
sh scripts/serve.sh --host 127.0.0.1 --port 5274
```

使用默认监听设置时，在文档中点击「复制协作链接」。从 `localhost` / `127.0.0.1` 页面分享，会通过 `/api/share-addresses` 获取服务电脑的私网 IPv4；多个候选地址需要选择双方可访问的网卡地址。若页面已经通过局域网 IP 或域名打开，分享保留当前协议、主机和端口。生成链接不会重定向当前页面或改变当前文档的浏览器存储来源。

也可在「系统设置 → 网络 → 当前连接的详细信息 → TCP/IP」手动查找服务电脑的 IP。例如地址为 `192.168.1.100`，另一台电脑打开的协作链接应以 `http://192.168.1.100:5274` 开头。另一台设备只需要浏览器，不需要安装项目。没有候选地址或请求失败时，按页面提示检查网络或手动使用已知的服务地址。

不要分享 `localhost`、`127.0.0.1` 或 `0.0.0.0`。自动列出 IP 不保证对方能连通；检查 macOS 防火墙是否允许 Python 入站连接、设备间网络是否互通，以及 VPN、访客网络隔离和端口占用。脚本不会自动修改防火墙。若显式使用 `--host 127.0.0.1`，需停止服务并以默认参数重启，其他设备才能连接。

HTTP 局域网支持在线协作和已打开页面断线后继续编辑；**整站离线后刷新需要可信 HTTPS，并且页面与文档已缓存**。

如果已有覆盖当前地址且被所有访问设备信任的证书，可启动 HTTPS：

```sh
sh scripts/serve.sh --host 0.0.0.0 --port 5274 \
  --ssl-certfile .local-certs/lan.pem \
  --ssl-keyfile .local-certs/lan-key.pem
```

此时访问 `https://实际局域网IP:5274`。证书必须覆盖分享时所选的 IP 或域名，按钮不会替你验证证书。证书可按 [mkcert 官方说明](https://github.com/FiloSottile/mkcert) 生成；只在服务电脑安装根证书不会让其他设备自动信任它，不能通过忽略证书错误代替信任配置。私钥不要上传或分享。

协议、IP 或端口改变都会改变浏览器本地存储的来源。未同步内容先导出备份；具体步骤见 [换地址迁移指南](local-and-lan.md#三换地址后迁移未同步的内容)。

## 数据目录

默认保存在仓库的 `backend/data/v2`。指定其他目录时，在同一条启动命令前设置环境变量：

```sh
COLLAB_DATA_DIR="$HOME/dom-collab-data" sh scripts/serve.sh
```

脚本保留这个设置；相对路径以仓库根目录为基准。正常停止服务后再复制整个数据目录做备份。不能同时启动多个服务进程操作同一数据目录；后端只支持一个 worker。

## 开发与测试

需要前端热更新时，先停止构建版，再开两个终端，都进入仓库根目录。

终端 A 运行后端：

```sh
backend/.venv/bin/python -m uvicorn app.main:app --app-dir backend \
  --host 127.0.0.1 --port 8787 --workers 1 --timeout-graceful-shutdown 10
```

终端 B 运行前端：

```sh
npm --prefix frontend run dev
```

打开 **<http://127.0.0.1:5273>**。前端默认监听所有 IPv4 网卡，其他设备可通过服务电脑的局域网 IP 访问 5273；Vite 代理 API / WebSocket，后端 8787 仍只监听本机。若前端也只供本机使用，运行 `npm --prefix frontend run dev -- --host 127.0.0.1`。开发版不提供页面离线缓存；验收离线刷新用 5274 构建版。分别在各终端按 Control+C 停止。

自动化测试命令如下，按顺序执行，任一步失败应先检查原因。端到端测试使用临时数据目录；运行应用本身不需要安装测试浏览器。

```sh
backend/.venv/bin/python -m pytest -c backend/pyproject.toml backend/tests -q
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend exec -- playwright install chromium
npm --prefix frontend run test:e2e
npm --prefix frontend run build
npm --prefix frontend run test:e2e:production
```

## 常见问题与验证范围

| 现象 | 处理 |
| --- | --- |
| `command not found: python3.12` | 安装 Python 3.12 并重新打开终端；先确认版本再创建虚拟环境 |
| 提示找不到 `backend/.venv/bin/python` | 在当前 Mac 创建虚拟环境并安装依赖，不要复用 Windows 虚拟环境 |
| 提示找不到 `frontend/dist/index.html` | 在仓库根目录运行 `npm --prefix frontend ci` 和 `npm --prefix frontend run build` |
| `Address already in use` | 停止占用端口的服务，或指定 `--port 其他端口`；访问地址也相应更换 |
| pip 下载超时 | 检查网络后重试同一安装命令；保留 `--require-hashes` 校验 |

已检查 shell 语法，并在 Windows 的 Git Bash 下通过适配解释器验证入口、参数和数据目录；Python 3.12 的 Mac Intel / Apple Silicon 依赖解析与轮子检查已通过。**这些检查不等于 Mac 真机验收**，当前未在 Mac 上完成安装、浏览器协作、系统中文输入法和真实双设备局域网的全流程测试。

首次在 Mac 跑通后，建议按 [演示步骤](demo.md) 验证双端同步、断线重连和重启后的内容恢复，再按 [中文输入法检查表](manual-ime-checklist.md) 验证实际输入法。
