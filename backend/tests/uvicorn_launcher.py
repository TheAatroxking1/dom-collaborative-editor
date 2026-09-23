"""仅测试使用的服务器启动器：允许从标准输入请求一次正常停止。

正式应用不挂载任何停止控制。端到端测试需要验证「最后一个客户端离开后正常停服」
以及 lifespan 的收尾流程（包括停机时写完整状态），所以这里持有 ``uvicorn.Server``
并通过标准输入触发 ``should_exit``，让 uvicorn 走正常的关闭路径。

强制结束（崩溃）场景不使用本启动器：那种情况必须用真正的进程终止。
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import uvicorn  # noqa: E402

from app.main import create_app  # noqa: E402

STOP_COMMAND = "stop"


def watch_stdin(server: uvicorn.Server) -> None:
    """读到 stop 就请求正常关闭；标准输入关闭时同样退出。"""
    try:
        for line in sys.stdin:
            if line.strip() == STOP_COMMAND:
                break
    except Exception:  # noqa: BLE001 - 管道断开时按停止处理
        pass
    server.should_exit = True


def main() -> None:
    data_directory = Path(os.environ["COLLAB_DATA_DIR"])
    port = int(os.environ.get("COLLAB_PORT", "8791"))

    # 可选：把构建好的页面资源也交给同一个进程提供。未设置时行为不变，
    # 仍是纯 API/WS 服务。
    static_directory = os.environ.get("COLLAB_STATIC_DIR") or None

    config = uvicorn.Config(
        create_app(data_directory, static_directory=static_directory),
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )
    server = uvicorn.Server(config)

    threading.Thread(target=watch_stdin, args=(server,), daemon=True).start()
    server.run()


if __name__ == "__main__":
    main()
