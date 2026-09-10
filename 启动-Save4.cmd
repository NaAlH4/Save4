@echo off
rem ═══════════════════════════════════════════════════════
rem  Save4 桌面版启动脚本
rem  用法1: 双击本文件运行
rem  用法2: 右键本文件 → 发送到 → 桌面快捷方式，以后双击桌面图标即启动
rem  可选:  想用「普通窗口模式」代替「透明置顶覆盖层」时，
rem          先 set SAVE4_WINDOW=window 再运行（见下注释行）
rem ═══════════════════════════════════════════════════════
cd /d "%~dp0"

rem 若需普通窗口模式，取消下面一行的注释：
rem set SAVE4_WINDOW=window

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装: https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo 首次运行，正在准备 Electron 运行环境（需要联网下载，约 110MB）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo 正在启动 Save4 桌宠...（退出请右键任务栏托盘图标）
call npm start
