#Requires -Version 5.1
<#
.SYNOPSIS
    按顺序运行本项目的全部自动验证，任一步失败立即以该步的退出码结束。

.DESCRIPTION
    先跑后端与前端单测，再做类型检查与构建，最后跑端到端测试。
    后续步骤成功不会覆盖前面步骤的失败：一旦某步失败就停止并返回它的退出码。

    端到端测试需要浏览器。若本机无法从官方源下载 Chromium，可先设置
    PLAYWRIGHT_CHROMIUM_PATH 指向已有的 chrome.exe。

.EXAMPLE
    pwsh -File scripts/verify.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 源码与测试大量使用中文，显式固定 UTF-8，避免控制台代码页影响输出与断言。
$env:PYTHONUTF8 = '1'

$python = Join-Path $root 'backend\.venv\Scripts\python.exe'

if (-not (Test-Path $python)) {
    Write-Host '未找到后端虚拟环境，请先执行：' -ForegroundColor Yellow
    Write-Host '  uv venv --python 3.12 backend/.venv'
    Write-Host '  uv pip sync --python backend/.venv/Scripts/python.exe --require-hashes backend/requirements.lock'
    Write-Host '  npm --prefix frontend ci'
    exit 1
}

$steps = @(
    @{
        Name    = '后端单元与集成测试'
        Command = $python
        Args    = @('-m', 'pytest', '-c', 'backend/pyproject.toml', 'backend/tests', '-q')
    },
    @{
        Name    = '前端单元测试'
        Command = 'npm'
        Args    = @('--prefix', 'frontend', 'test')
    },
    @{
        Name    = '前端类型检查'
        Command = 'npm'
        Args    = @('--prefix', 'frontend', 'run', 'typecheck')
    },
    @{
        Name    = '前端构建'
        Command = 'npm'
        Args    = @('--prefix', 'frontend', 'run', 'build')
    },
    @{
        Name    = '端到端测试（开发模式）'
        Command = 'npm'
        Args    = @('--prefix', 'frontend', 'run', 'test:e2e')
    },
    @{
        # 必须在上一步的 build 之后运行：这一个套件用真实构建产物和
        # context.setOffline(true) 验证整站断网刷新，只断后端证明不了。
        Name    = '端到端测试（生产构建版）'
        Command = 'npm'
        Args    = @('--prefix', 'frontend', 'run', 'test:e2e:production')
    }
)

foreach ($step in $steps) {
    Write-Host ''
    Write-Host ("==> {0}" -f $step.Name) -ForegroundColor Cyan
    & $step.Command @($step.Args)
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host ("验证失败：{0}（退出码 {1}）" -f $step.Name, $LASTEXITCODE) -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Host ''
Write-Host '全部验证通过。' -ForegroundColor Green
exit 0
