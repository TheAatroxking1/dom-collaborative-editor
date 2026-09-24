@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
set "_collabNoPause="
if /I "%~1"=="--no-pause" (
    set "_collabNoPause=1"
    shift /1
)
set "_collabArgs="
:collectArgs
if "%~1"=="" goto run
set "_collabArgs=%_collabArgs% %1"
shift /1
goto collectArgs
:run
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\serve.ps1" %_collabArgs%
set "_collabExitCode=%errorlevel%"
if not defined _collabNoPause pause
exit /b %_collabExitCode%
