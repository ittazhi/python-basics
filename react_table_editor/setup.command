#!/bin/sh
set -u

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
NODE_URL="https://nodejs.org/zh-cn/download"

pause_window() {
  printf "\n按 Enter 关闭窗口..."
  read -r _
}

cd "$APP_DIR" || exit 1

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "未检测到 Node.js / npm。"
  echo "请先安装 Node.js LTS，安装完成后再双击本文件。"
  echo "$NODE_URL"
  if command -v open >/dev/null 2>&1; then
    open "$NODE_URL"
  fi
  pause_window
  exit 1
fi

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"
echo ""

node scripts/setup.mjs
status=$?

if [ "$status" -ne 0 ]; then
  echo ""
  echo "启动失败。请确认 Node.js LTS 已正确安装。"
  pause_window
  exit "$status"
fi
