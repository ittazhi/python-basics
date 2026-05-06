@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto missing_node

where npm >nul 2>nul
if errorlevel 1 goto missing_node

echo Node:
node --version
echo npm:
npm --version
echo.

node scripts\setup.mjs
if errorlevel 1 (
  echo.
  echo 启动失败。请确认 Node.js LTS 已正确安装。
  pause
  exit /b 1
)

exit /b 0

:missing_node
echo 未检测到 Node.js / npm。
echo 请先安装 Node.js LTS，安装完成后再双击本文件。
echo https://nodejs.org/zh-cn/download
start "" "https://nodejs.org/zh-cn/download"
pause
exit /b 1
