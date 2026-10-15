#!/bin/bash
# 游巷 · macOS 启动器
# 用法：双击本文件（首次可能需要在「系统设置 → 隐私与安全性」里允许运行），
#      或在终端里执行  chmod +x start.command && ./start.command
cd "$(dirname "$0")" || exit 1

echo "=========================================="
echo "  游巷 · AI 旅行札记"
echo "=========================================="

# ---- 检查 Node.js ----
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没有找到 Node.js。"
  echo "       请先安装 Node.js 22.5 或更高版本：https://nodejs.org"
  echo "       或使用 Homebrew：brew install node"
  echo
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

# node:sqlite 是 Node 22.5 才有的内置模块，22.4 及以下直接起不来，先拦住并说清楚
NODE_OK=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.stdout.write(a>22||(a===22&&b>=5)?"1":"0")')
if [ "$NODE_OK" != "1" ]; then
  echo "[错误] 需要 Node.js 22.5 或更高版本，当前是 $(node -v)。"
  echo "       本应用用 Node 内置的 node:sqlite，22.4 及以下没有这个模块。"
  echo
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

# ---- 依赖 ----
if [ ! -d node_modules ]; then
  echo "首次运行：正在安装依赖，请稍候…"
  npm install --omit=dev --no-audit --no-fund || { echo "[错误] 依赖安装失败，请检查网络。"; read -n 1 -s -r -p "按任意键关闭…"; exit 1; }
fi

if [ ! -d web/dist ]; then
  echo "[提示] 缺少前端构建产物 web/dist。"
  echo "       如果你拿到的是源码包，请先执行：npm run build:web"
fi

echo
echo "  启动地址：http://localhost:9610"
echo "  默认账号：admin / admin123（登录后请在「设置 → 用户管理」里改掉）"
echo "  停止服务：在本窗口按 Control + C"
echo
node --no-warnings server/index.js

echo
echo "服务已停止。"
read -n 1 -s -r -p "按任意键关闭窗口…"
