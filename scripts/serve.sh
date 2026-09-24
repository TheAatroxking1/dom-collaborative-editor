#!/bin/sh
# macOS 构建版入口：前台运行同一个 FastAPI 服务，Ctrl+C 交给 Uvicorn 正常处理。
# 默认监听所有 IPv4 网卡；仅本机使用可传 --host 127.0.0.1。
# 用法：sh scripts/serve.sh [backend/serve.py 参数，例如 --no-browser --port 5274]
set -eu

ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PYTHON="$ROOT/backend/.venv/bin/python"
if [ ! -x "$PYTHON" ]; then
    printf '%s\n' \
        '未找到 macOS 虚拟环境 backend/.venv/bin/python，请先执行：' \
        '  python3.12 -m venv backend/.venv' \
        '  backend/.venv/bin/python -m pip install --require-hashes -r backend/requirements.lock' >&2
    exit 1
fi

if [ ! -f "$ROOT/frontend/dist/index.html" ]; then
    printf '%s\n' \
        '未找到构建产物 frontend/dist/index.html，请先执行：' \
        '  npm --prefix frontend ci' \
        '  npm --prefix frontend run build' >&2
    exit 1
fi

export PYTHONUTF8=1
export COLLAB_STATIC_DIR="$ROOT/frontend/dist"
# COLLAB_DATA_DIR 保留调用者的设置；未设置时由应用采用 backend/data/v2。
printf '%s\n' \
    '启动构建版，实际访问地址和浏览器提示见下方输出。' \
    '按 Ctrl+C 正常停止。切换开发/构建模式前，请先停止使用同一数据目录的另一服务。'

# exec 保持前台进程和信号语义，不创建后台进程、trap 或额外进程管理器。
# 参数交给共享入口校验；worker 数和正常停机超时由该入口固定。
exec "$PYTHON" backend/serve.py "$@"
