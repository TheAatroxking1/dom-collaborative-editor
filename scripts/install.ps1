#Requires -Version 5.1
# install.bat 的安装逻辑。可点源加载以验证流程，直接运行才执行安装。
$script:root = Split-Path -Parent $PSScriptRoot

function Invoke-Checked {
    param([string]$FilePath, [string[]]$Arguments)
    Write-Host ("> {0} {1}" -f $FilePath, ($Arguments -join ' ')) -ForegroundColor DarkGray
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "命令失败（退出码 $LASTEXITCODE）：$FilePath $($Arguments -join ' ')"
    }
}

function Refresh-ProcessPath {
    # 只刷新当前进程，兼容安装器刚注册的命令；不写系统或用户 PATH。
    $env:Path = [Environment]::ExpandEnvironmentVariables((@(
        [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User'),
        $env:Path
    ) -join ';'))
}

function Test-Python312 {
    param([string]$FilePath)
    try {
        $version = & $FilePath --version 2>$null
        return ($LASTEXITCODE -eq 0 -and "$version" -match '^Python 3\.12\.')
    } catch { return $false }
}

function Get-PythonManager {
    $command = Get-Command pymanager.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    # Store 与 python.org 的管理器都可复用，避免 PATH 未刷新时误装另一发行版。
    foreach ($family in @('PythonSoftwareFoundation.PythonManager_3847v3x7pw1km',
                          'PythonSoftwareFoundation.PythonManager_qbz5n2kfra8p0')) {
        $alias = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\$family\pymanager.exe"
        if (Test-Path -LiteralPath $alias) { return $alias }
    }
}

function Get-Python312 {
    $launcher = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($launcher) {
        $automaticInstall = [Environment]::GetEnvironmentVariable('PYTHON_MANAGER_AUTOMATIC_INSTALL', 'Process')
        try {
            # 新版 py 在无运行时时可能自动安装；探测阶段只读取已安装版本。
            $env:PYTHON_MANAGER_AUTOMATIC_INSTALL = 'false'
            $candidate = & $launcher.Source -3.12 -c 'import sys; print(sys.executable)' 2>$null
            if ($LASTEXITCODE -eq 0 -and (Test-Python312 "$candidate")) { return "$candidate" }
        } catch { } finally {
            [Environment]::SetEnvironmentVariable('PYTHON_MANAGER_AUTOMATIC_INSTALL', $automaticInstall, 'Process')
        }
    }
    $manager = Get-PythonManager
    if ($manager) {
        try {
            $candidates = & $manager list --format=exe 3.12 2>$null
            if ($LASTEXITCODE -eq 0) {
                foreach ($candidate in $candidates) {
                    if (Test-Python312 "$candidate") { return "$candidate" }
                }
            }
        } catch { }
    }
    foreach ($command in @(Get-Command python.exe -All -CommandType Application -ErrorAction SilentlyContinue)) {
        # 未安装 Python 时，通用 WindowsApps 别名可能打开商店。
        if ($command.Source -notlike '*\Microsoft\WindowsApps\*' -and (Test-Python312 $command.Source)) {
            return $command.Source
        }
    }
}

function Get-Node24 {
    $candidates = @(Get-Command node.exe -All -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Source)
    $tools = Join-Path $script:root '.tools'
    if (Test-Path -LiteralPath $tools) {
        $candidates += @(Get-ChildItem -LiteralPath $tools -Directory -Filter 'node-v24.*-win-*' |
            ForEach-Object { Join-Path $_.FullName 'node.exe' })
    }
    foreach ($candidate in $candidates) {
        try {
            $version = & $candidate --version 2>$null
            $npm = Join-Path (Split-Path -Parent $candidate) 'node_modules\npm\bin\npm-cli.js'
            if ($LASTEXITCODE -eq 0 -and "$version" -match '^v24\.' -and (Test-Path -LiteralPath $npm)) {
                return $candidate
            }
        } catch { }
    }
}

function Install-Node24 {
    Write-Host '正在下载 Node.js 24 官方便携版到 .tools（不改系统 Node.js）...' -ForegroundColor Cyan
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
        'arm64'
    } elseif ([Environment]::Is64BitOperatingSystem) { 'x64' } else {
        throw '一键安装需要 64 位 Windows。'
    }
    $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
    $release = $releases | Where-Object { $_.version -match '^v24\.\d+\.\d+$' } |
        Sort-Object { [version]$_.version.Substring(1) } -Descending | Select-Object -First 1
    if (-not $release) { throw '无法从 Node.js 官方列表获取 24.x 版本。' }
    $name = "node-$($release.version)-win-$arch.zip"
    $baseUrl = "https://nodejs.org/dist/$($release.version)"
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt").Content
    $match = [regex]::Match($checksums, ('(?m)^([a-fA-F0-9]{64})\s+' + [regex]::Escape($name) + '\r?$'))
    if (-not $match.Success) { throw "官方校验文件中没有 $name，已停止下载。" }
    $tools = Join-Path $script:root '.tools'
    New-Item -ItemType Directory -Force -Path $tools | Out-Null
    $archive = Join-Path $tools $name
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$name" -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $match.Groups[1].Value) {
        throw "Node.js 下载文件校验失败，请重新运行 install.bat。未解压：$archive"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $tools -Force
    Remove-Item -LiteralPath $archive
}

function Install-Python312 {
    $manager = Get-PythonManager
    if (-not $manager) {
        if (Get-AppxPackage -Name PythonSoftwareFoundation.PythonManager -ErrorAction SilentlyContinue) {
            throw '已安装 Python Install Manager，但其命令不可用。请在 Windows 的“管理应用执行别名”中启用 pymanager，然后重新运行 install.bat。'
        }
        Write-Host '正在安装 Python 官方安装管理器，系统可能要求确认安装...' -ForegroundColor Cyan
        Add-AppxPackage -AppInstallerFile 'https://www.python.org/ftp/python/pymanager/pymanager.appinstaller'
        Refresh-ProcessPath
        $manager = Get-PythonManager
        if (-not $manager) {
            throw '未找到 Python Install Manager 命令。请重新打开 install.bat；若仍失败，请按 README 的 Python 官方安装器步骤安装。'
        }
    }
    Write-Host '正在安装 Python 3.12...' -ForegroundColor Cyan
    Invoke-Checked -FilePath $manager -Arguments @('install', '3.12')
    Refresh-ProcessPath
}

function Install-Project {
    Set-Location -LiteralPath $script:root
    foreach ($file in @('backend\requirements.lock', 'frontend\package-lock.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $script:root $file))) {
            throw "缺少 $file。请先完整解压仓库，再运行 install.bat。"
        }
    }
    $venv = Join-Path $script:root 'backend\.venv'
    $python = Join-Path $venv 'Scripts\python.exe'
    if (Test-Path -LiteralPath $venv) {
        if (-not (Test-Path -LiteralPath $python) -or -not (Test-Python312 $python)) {
            throw '已有 backend/.venv 不完整或不是 Python 3.12。请先停止服务，将这个虚拟环境目录改名保留后重试；不要移动或删除 backend/data。'
        }
    } else {
        $basePython = Get-Python312
        if (-not $basePython) {
            Install-Python312
            $basePython = Get-Python312
        }
        if (-not $basePython) { throw '安装后仍未找到 Python 3.12，请查看上方安装日志。' }
        Invoke-Checked -FilePath $basePython -Arguments @('-m', 'venv', $venv)
    }

    $node = Get-Node24
    if (-not $node) {
        Install-Node24
        $node = Get-Node24
    }
    if (-not $node) { throw '安装后仍未找到 Node.js 24 和 npm，请查看上方安装日志。' }
    # npm 的子进程也使用已选定的 Node，避免命中系统中的另一版本。
    $env:Path = (Split-Path -Parent $node) + ';' + $env:Path
    $npm = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
    Write-Host '正在安装后端依赖...' -ForegroundColor Cyan
    # uv 创建的已有虚拟环境可能不带 pip；ensurepip 使用 Python 内置资源补齐。
    Invoke-Checked -FilePath $python -Arguments @('-m', 'ensurepip', '--upgrade')
    Invoke-Checked -FilePath $python -Arguments @('-m', 'pip', 'install', '--require-hashes', '-r', 'backend/requirements.lock')
    Write-Host '正在安装并构建前端...' -ForegroundColor Cyan
    Invoke-Checked -FilePath $node -Arguments @($npm, '--prefix', 'frontend', 'ci')
    Invoke-Checked -FilePath $node -Arguments @($npm, '--prefix', 'frontend', 'run', 'build')
    Write-Host '安装完成。双击根目录 start.bat，再打开 http://127.0.0.1:5274' -ForegroundColor Green
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $env:PYTHONUTF8 = '1'
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $exitCode = 1
    $logging = $false
    try {
        Start-Transcript -Path (Join-Path $script:root 'install.log') -Append | Out-Null
        $logging = $true
        Write-Host '开始安装：请保持联网；已有服务请先按 Ctrl+C 停止。' -ForegroundColor Cyan
        Refresh-ProcessPath
        Install-Project
        $exitCode = 0
    } catch {
        Write-Host ("安装失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
        Write-Host '请保留上方报错或根目录 install.log。解决原因后可再次运行 install.bat。'
    } finally {
        if ($logging) { Stop-Transcript | Out-Null }
    }
    exit $exitCode
}
