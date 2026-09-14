@echo off
chcp 65001 >nul
setlocal
rem ═══════════════════════════════════════════════════════════
rem  Save4 — 一键发布：把 release\ 下的 exe 上传到 GitHub Releases
rem  用法：双击本文件即可（版本号取自 package.json）
rem       或：发布新版.cmd v0.1.2   （显式指定 tag）
rem  代理：下面这行按你的实际情况改；若不需要代理就把它注释掉
rem ═══════════════════════════════════════════════════════════
set HTTPS_PROXY=http://127.0.0.1:9567
set HTTP_PROXY=http://127.0.0.1:9567

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装: https://nodejs.org
  pause
  exit /b 1
)

echo ============================================================
echo   Save4 发布上传
echo   代理: %HTTPS_PROXY%
echo ============================================================
echo.

node scripts\publish-release.js %*

echo.
echo ============================================================
pause
