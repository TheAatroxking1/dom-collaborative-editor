"""仅测试使用的服务器启动器：允许从标准输入请求一次正常停止。

正式应用不挂载任何停止控制。端到端测试需要验证「最后一个客户端离开后正常停服」
以及 lifespan 的收尾流程（包括停机时写完整状态），所以这里持有 ``uvicorn.Server``
并通过标准输入触发 ``should_exit``，让 uvicorn 走正常的关闭路径。

强制结束（崩溃）场景不使用本启动器：那种情况必须用真正的进程终止。
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import uvicorn  # noqa: E402

from app.main import create_app  # noqa: E402

STOP_COMMAND = "stop"

#: 停机时等待现有连接收敛的上限。超过就取消剩余任务并继续关闭。
#:
#: uvicorn 默认不设上限，连接不收敛时会无限等待，进程永不退出、lifespan 收尾也
#: 不会执行。这里给一个明确上界，让「正常停止」在任何情况下都能完成。
GRACEFUL_SHUTDOWN_SECONDS = 10

#: 我们在停机阶段观察到的 uvicorn 连接拆除竞态。
#:
#: uvicorn 0.53.0 的 ``Server.shutdown`` 会对每个已有连接调用
#: ``connection.shutdown()``，其中无条件地给 WebSocket 发一个关闭帧。如果该连接在
#: 此刻已经处于 closing 状态（客户端正在断开，或刚刚断开），websockets 会抛
#: ``InvalidState: connection is closing``。这个异常穿出 ``Server.serve()``，
#: 进程以退出码 1 结束。
#:
#: 它发生在应用自身的 lifespan 收尾之外：我们的停机写回已经完成。启动失败、
#: lifespan 异常都不是这个形状，因此这里只按异常类型与文案精确匹配，不做兜底吞异常。
SHUTDOWN_RACE_MARKER = "connection is closing"

#: 故障注入开关：置 1 时让应用在停机写回阶段失败。
#:
#: 「停机写盘失败必须让进程以非零码退出」是这套停机测试的可信度所在，而真实的写盘
#: 失败（存储只读、磁盘故障）没法在自动测试里稳定复现。开关只存在于这个测试启动器
#: 里，不进正式应用。
FORCE_SHUTDOWN_FAILURE_VARIABLE = "COLLAB_LAUNCHER_FORCE_SHUTDOWN_FAILURE"


def inject_shutdown_failure() -> None:
    """把 ``Collaboration.close`` 换成必定失败的版本。

    只替换停机写回这一步，启动、接客与正常收发都不受影响，因此测出来的仍然是
    「停机失败会不会被当成成功」这一条。
    """
    from app.collaboration import Collaboration, StorageUnavailable

    async def failing_close(self: Collaboration) -> None:
        raise StorageUnavailable("注入的停机写盘失败")

    Collaboration.close = failing_close  # type: ignore[method-assign]


def is_connection_teardown_race(error: BaseException) -> bool:
    """判断异常是否是上面那种「停机时连接正在关闭」的竞态。"""
    return type(error).__name__ == "InvalidState" and SHUTDOWN_RACE_MARKER in str(error)


def server_shutdown_failed(server: uvicorn.Server) -> bool:
    """uvicorn 是否因为 lifespan 的**停机**异常而结束。

    uvicorn 只在**启动**失败时用非零退出码结束进程；lifespan 的**停机**异常它只打
    一行「Application shutdown failed」日志，然后让 ``serve()`` 正常返回，进程仍以
    0 退出。应用停机写盘失败（``Collaboration.close`` 抛 ``StorageUnavailable``）
    走的正是这条路径——不查这个标志，测试就会把「没写成功」当成「正常停止」。

    按 uvicorn 自己的标志判定，而不是靠日志文本匹配：这个标志就是它内部用来决定
    「Application shutdown failed」的那一个。
    """
    return bool(getattr(getattr(server, "lifespan", None), "shutdown_failed", False))


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
    log_level = os.environ.get("COLLAB_LOG_LEVEL", "warning")

    # 排查停机问题时需要看到应用自己的记录。Python 默认只把 WARNING 以上送到
    # 「最后的处理器」，配置根 logger 才能让 app.collaboration 的 INFO 真正出现。
    if log_level.lower() in {"info", "debug"}:
        logging.basicConfig(level=logging.INFO, format="[app] %(levelname)s %(name)s: %(message)s")

    # 可选：把构建好的页面资源也交给同一个进程提供。未设置时行为不变，
    # 仍是纯 API/WS 服务。
    static_directory = os.environ.get("COLLAB_STATIC_DIR") or None

    if os.environ.get(FORCE_SHUTDOWN_FAILURE_VARIABLE) == "1":
        inject_shutdown_failure()

    config = uvicorn.Config(
        create_app(data_directory, static_directory=static_directory),
        host="127.0.0.1",
        port=port,
        log_level=log_level,
        # 停机必须有时限。uvicorn 默认不设上限：它会先给每个连接发关闭帧，再无限期
        # 等待这些连接的处理任务结束。浏览器上下文被强制关闭时，连接可能一直不收敛，
        # 于是「请求停止」之后进程永远不退出，lifespan 收尾（写回完整状态）也永远不执行。
        # 超过这个时间 uvicorn 会取消剩余任务并继续走 lifespan shutdown。
        timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_SECONDS,
    )
    server = uvicorn.Server(config)

    threading.Thread(target=watch_stdin, args=(server,), daemon=True).start()

    try:
        server.run()
    except BaseException as error:  # noqa: BLE001 - 需要区分竞态与真实失败
        # 我们已经请求过停止、服务确实起来了，且异常正是那个已知竞态：按正常停止
        # 收尾，不把这个 uvicorn 缺陷报成失败。应用究竟有没有完成停机写回，交给
        # 下面的标志判定，不由这个豁免推断。
        if not (server.started and server.should_exit and is_connection_teardown_race(error)):
            traceback.print_exc()
            raise SystemExit(1)
        print(
            "[launcher] 忽略 uvicorn 停机时已知的连接拆除竞态",
            file=sys.stderr,
        )

    # 走到这里说明 uvicorn 认为服务已结束。但它不会因为 lifespan 的停机异常而返回
    # 非零，所以这里必须自己判：否则「停机写盘失败」会被调用方当成「正常停止」。
    if server_shutdown_failed(server):
        print(
            "[launcher] 应用停机失败（完整 traceback 见 uvicorn 日志），按失败退出",
            file=sys.stderr,
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
