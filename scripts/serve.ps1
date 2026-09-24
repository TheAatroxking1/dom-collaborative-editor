#Requires -Version 5.1
<#
.SYNOPSIS
    前台运行构建版：一个进程同时提供页面、API 与 WebSocket。

.DESCRIPTION
    与 dev.ps1 不同，本脚本通过共享 Python 入口在前台运行 Uvicorn，Ctrl+C 走其正常
    停机流程（会触发协作房间写下完整状态）。不使用 Start-Process、不使用
    taskkill、不按端口结束任何进程。

    默认监听 0.0.0.0:5274，服务就绪后打开局域网页面；多网卡时先选择地址。
    与开发版的 5273 分开：生产 Service Worker 只
    作用于它自己的 origin，两个模式用不同端口可以避免它接管开发页面。

    提供 CertFile/KeyFile 时启用 TLS。局域网内完整离线刷新需要可信 HTTPS；
    HTTP 下仍可在线协作，但不能保证整站断网后还能打开页面。

    **切换开发/构建模式前先停掉另一个后端。** 即使端口不同，也不要有两个 Python
    进程同时写同一个 COLLAB_DATA_DIR。

.EXAMPLE
    pwsh -File scripts/serve.ps1
.EXAMPLE
    pwsh -File scripts/serve.ps1 -HostAddress 0.0.0.0 -Port 5274 `
        -CertFile .local-certs/lan.pem -KeyFile .local-certs/lan-key.pem
#>
[CmdletBinding()]
param(
    [string]$HostAddress = '0.0.0.0',
    [int]$Port = 5274,
    [string]$CertFile = '',
    [string]$KeyFile = '',
    [switch]$NoBrowser,
    [string]$BrowserHost = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:PYTHONUTF8 = '1'

$python = Join-Path $root 'backend\.venv\Scripts\python.exe'
$staticDirectory = Join-Path $root 'frontend\dist'
$indexHtml = Join-Path $staticDirectory 'index.html'

if (-not (Test-Path $python)) {
    Write-Host '未找到后端虚拟环境 backend/.venv，请先执行：' -ForegroundColor Yellow
    Write-Host '  py -3.12 -m venv backend/.venv'
    Write-Host '  .\backend\.venv\Scripts\python.exe -m pip install --require-hashes -r backend/requirements.lock'
    exit 1
}

if (-not (Test-Path $indexHtml)) {
    Write-Host '未找到构建产物 frontend/dist/index.html，请先执行：' -ForegroundColor Yellow
    Write-Host '  npm --prefix frontend ci'
    Write-Host '  npm --prefix frontend run build'
    exit 1
}

if ($Port -lt 1 -or $Port -gt 65535) {
    Write-Host "端口不合法：$Port（应在 1-65535）" -ForegroundColor Red
    exit 1
}

# 两个证书参数必须同时提供，且文件确实存在；不静默降级成 HTTP。
$useTls = $false
if ($CertFile -or $KeyFile) {
    if (-not $CertFile -or -not $KeyFile) {
        Write-Host 'CertFile 与 KeyFile 必须同时提供。' -ForegroundColor Red
        exit 1
    }
    foreach ($file in @($CertFile, $KeyFile)) {
        if (-not (Test-Path $file)) {
            Write-Host "证书文件不存在：$file" -ForegroundColor Red
            exit 1
        }
    }
    $useTls = $true
}

# 静态目录用绝对路径传入；COLLAB_DATA_DIR 保持用户已有的设置不变。
$env:COLLAB_STATIC_DIR = (Resolve-Path $staticDirectory).Path

$serverArgs = @(
    'backend/serve.py', '--host', $HostAddress, '--port', "$Port"
)
if ($useTls) {
    $serverArgs += @('--ssl-certfile', $CertFile, '--ssl-keyfile', $KeyFile)
}
if ($NoBrowser) {
    $serverArgs += '--no-browser'
}
if ($BrowserHost) {
    $serverArgs += @('--browser-host', $BrowserHost)
}

Write-Host '启动构建版，实际访问地址和浏览器提示见下方输出。' -ForegroundColor Green
Write-Host '按 Ctrl+C 正常停止（会触发服务端写下完整状态）。' -ForegroundColor DarkGray
Write-Host ''

& $python @serverArgs
exit $LASTEXITCODE
