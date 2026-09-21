#Requires -Version 5.1
<#
.SYNOPSIS
    在本机启动后端同步服务与前端开发服务器。

.DESCRIPTION
    只启动本脚本自己创建的两个子进程，并在退出时按 PID 终止它们（含各自的
    子进程树）。不会按端口去结束未知进程——那些可能是其他项目正在使用的服务。

    默认端口刻意避开 5173 与 8000：这两个端口在开发机上经常被其他项目或 Docker
    占用。确实需要时用 -BackendPort / -FrontendPort 指定。

    缺少依赖时只打印精确的安装命令并退出，不擅自修改全局环境。

.EXAMPLE
    pwsh -File scripts/dev.ps1
#>
[CmdletBinding()]
param(
    [int]$BackendPort = 8787,
    [int]$FrontendPort = 5273
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:PYTHONUTF8 = '1'

$python = Join-Path $root 'backend\.venv\Scripts\python.exe'
$nodeModules = Join-Path $root 'frontend\node_modules'

if (-not (Test-Path $python)) {
    Write-Host '未找到后端虚拟环境 backend/.venv，请先执行：' -ForegroundColor Yellow
    Write-Host "  uv venv --python 'D:\Python\python.exe' backend/.venv"
    Write-Host '  uv pip compile backend/requirements.in --python-version 3.12 --generate-hashes --output-file backend/requirements.lock'
    Write-Host '  uv pip sync --python backend/.venv/Scripts/python.exe --require-hashes backend/requirements.lock'
    exit 1
}

if (-not (Test-Path $nodeModules)) {
    Write-Host '未找到 frontend/node_modules，请先执行：' -ForegroundColor Yellow
    Write-Host '  npm --prefix frontend install'
    exit 1
}

# 只终止自己启动的进程及其子进程树，绝不按端口结束未知进程。
function Stop-OwnProcess {
    param([System.Diagnostics.Process]$Process)
    if ($null -eq $Process -or $Process.HasExited) { return }
    & taskkill.exe /T /F /PID $Process.Id 2>$null | Out-Null
}

$backend = $null
$frontend = $null

try {
    Write-Host '启动后端同步服务…' -ForegroundColor Cyan
    $backend = Start-Process -FilePath $python `
        -ArgumentList @(
            '-m', 'uvicorn', 'app.main:app',
            '--app-dir', 'backend',
            '--host', '127.0.0.1',
            '--port', "$BackendPort"
        ) `
        -WorkingDirectory $root -PassThru -WindowStyle Hidden

    $health = "http://127.0.0.1:$BackendPort/api/health"
    $deadline = (Get-Date).AddSeconds(30)
    while ($true) {
        try {
            $response = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { break }
        } catch {
            if ((Get-Date) -gt $deadline) { throw "后端未在 30 秒内就绪：$health" }
            Start-Sleep -Milliseconds 200
        }
    }
    Write-Host "后端就绪：$health" -ForegroundColor Green

    Write-Host '启动前端开发服务器…' -ForegroundColor Cyan
    $env:COLLAB_BACKEND_URL = "http://127.0.0.1:$BackendPort"
    $frontend = Start-Process -FilePath 'npm.cmd' `
        -ArgumentList @('--prefix', 'frontend', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', "$FrontendPort") `
        -WorkingDirectory $root -PassThru -WindowStyle Hidden

    Write-Host ''
    Write-Host "打开 http://127.0.0.1:$FrontendPort 开始使用。" -ForegroundColor Green
    Write-Host '按 Ctrl+C 结束，本脚本只会关闭它自己启动的进程。' -ForegroundColor DarkGray
    Write-Host ''

    # 任一子进程退出即结束脚本，避免留下半个环境。
    Wait-Process -Id @($backend.Id, $frontend.Id) -ErrorAction SilentlyContinue
} finally {
    Write-Host '正在关闭本脚本启动的进程…' -ForegroundColor DarkGray
    Stop-OwnProcess -Process $frontend
    Stop-OwnProcess -Process $backend
}
