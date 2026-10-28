#!/bin/bash
# PaperWeave macOS 一键构建：git pull 之后直接执行本脚本即可。
#   ./tools/build-mac.sh            # 构建当前机型架构（Apple Silicon → arm64，Intel → x64）
#   ./tools/build-mac.sh arm64      # 只构建 Apple Silicon
#   ./tools/build-mac.sh x64        # 只构建 Intel
#   ./tools/build-mac.sh all        # 两种架构都构建
# 产物输出到 release/（dmg + zip）。
set -e
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。请先安装 Node.js 18+：brew install node（或 https://nodejs.org）" >&2
  exit 1
fi

# 国内网络下载 Electron 二进制较慢时，可取消下一行注释使用 npmmirror 镜像
# export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

echo "[1/2] 安装依赖…"
npm install

ARCH="${1:-}"
case "$ARCH" in
  "" )    echo "[2/2] 构建 macOS 包（当前架构）…";  npm run dist:mac ;;
  x64|arm64) echo "[2/2] 构建 macOS 包（$ARCH）…";  npm run "dist:mac:$ARCH" ;;
  all )   echo "[2/2] 构建 macOS 包（x64 + arm64）…"
          npm run dist:mac:x64
          npm run dist:mac:arm64 ;;
  * )     echo "用法：$0 [x64|arm64|all]" >&2; exit 1 ;;
esac

echo "完成，产物见 release/："
ls -1 release/*.dmg release/*.zip 2>/dev/null || true
