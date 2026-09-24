#!/bin/sh
# macOS 构建版入口：前台运行同一个 FastAPI 服务，Ctrl+C 交给 Uvicorn 正常处理。
# 用法：sh scripts/serve.sh [Uvicorn 参数，例如 --host 0.0.0.0 --port 5274]
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
    '启动构建版，默认地址 http://127.0.0.1:5274；实际监听地址见下方 Uvicorn 日志。' \
    '按 Ctrl+C 正常停止。切换开发/构建模式前，请先停止使用同一数据目录的另一服务。'

# exec 保持前台进程和信号语义，不创建后台进程、trap 或额外进程管理器。
# 其他参数交给 Uvicorn 校验；始终只使用一个 worker。
exec "$PYTHON" -m uvicorn app.main:app --app-dir backend \
    --host 127.0.0.1 --port 5274 --timeout-graceful-shutdown 10 \
    "$@" --workers 1
