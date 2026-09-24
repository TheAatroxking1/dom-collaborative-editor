"""测试启动器的停机竞态判定与失败传播。

这个判定决定了「uvicorn 停机时抛出的连接拆除异常」算不算正常停止，写错就会把真实
失败一起吞掉，所以单独固定它的边界。

另一件事同样重要：uvicorn 只在**启动**失败时返回非零码，lifespan 的**停机**异常它
只打一行日志就正常返回。若不额外判定，停机写盘失败会被调用方当成「正常停止」，
停机测试就失去了可信度。这里用一个真实子进程验证那条路径确实会以非零码结束。
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from tests.uvicorn_launcher import (
    FORCE_SHUTDOWN_FAILURE_VARIABLE,
    is_connection_teardown_race,
    server_shutdown_failed,
)

BACKEND_DIRECTORY = Path(__file__).resolve().parents[1]
LAUNCHER_TIMEOUT_SECONDS = 60


class InvalidState(Exception):
    """模拟 websockets 的同名异常。"""


def test_matches_the_known_teardown_race():
    error = InvalidState("connection is closing")
    assert is_connection_teardown_race(error) is True


def test_matches_subclass_names_used_by_the_library():
    # websockets 的异常类型名就是 InvalidState，判定按名字而不是按导入路径，
    # 这样启动器不需要依赖 websockets 的内部模块布局。
    class InvalidState(Exception):  # noqa: F811 - 故意同名，验证按名字匹配
        pass

    assert is_connection_teardown_race(InvalidState("connection is closing")) is True


@pytest.mark.parametrize(
    "error",
    [
        InvalidState("connection is open"),
        InvalidState("connection is closed"),
        RuntimeError("connection is closing"),
        ValueError("connection is closing"),
        OSError("address already in use"),
    ],
)
def test_does_not_match_other_errors(error: BaseException):
    """类型或文案任一不符就不算竞态：启动失败必须照常失败。"""
    assert is_connection_teardown_race(error) is False


def test_detects_lifespan_shutdown_failure():
    """uvicorn 自己的停机失败标志必须被认出来。"""

    class Lifespan:
        shutdown_failed = True

    class Server:
        lifespan = Lifespan()

    assert server_shutdown_failed(Server()) is True


def test_normal_shutdown_is_not_a_failure():
    class Lifespan:
        shutdown_failed = False

    class Server:
        lifespan = Lifespan()

    assert server_shutdown_failed(Server()) is False


def test_shutdown_check_survives_a_server_that_never_started_lifespan():
    """启动阶段就没走到 lifespan 时不能反过来报成停机失败。"""

    class Server:
        lifespan = None

    assert server_shutdown_failed(Server()) is False


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_until_ready(port: int, process: subprocess.Popen[str]) -> None:
    deadline = time.monotonic() + LAUNCHER_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError(f"启动器在就绪前就退出了，退出码 {process.returncode}")
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/health", timeout=1
            ) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, OSError):
            time.sleep(0.1)
    raise AssertionError("启动器未在预期时间内就绪")


def _run_launcher(tmp_path: Path, *, force_shutdown_failure: bool) -> subprocess.CompletedProcess[str]:
    """真的跑一次启动器：起服务 → 从标准输入请求停止 → 收集退出码与输出。"""
    port = _free_port()
    environment = {
        **os.environ,
        "COLLAB_DATA_DIR": str(tmp_path / "data"),
        "COLLAB_PORT": str(port),
        "COLLAB_LOG_LEVEL": "info",
        "PYTHONUTF8": "1",
    }
    if force_shutdown_failure:
        environment[FORCE_SHUTDOWN_FAILURE_VARIABLE] = "1"

    process = subprocess.Popen(
        [sys.executable, "-m", "tests.uvicorn_launcher"],
        cwd=BACKEND_DIRECTORY,
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    try:
        _wait_until_ready(port, process)
        assert process.stdin is not None
        process.stdin.write("stop\n")
        process.stdin.flush()
        stdout, stderr = process.communicate(timeout=LAUNCHER_TIMEOUT_SECONDS)
    except BaseException:
        process.kill()
        process.communicate()
        raise
    return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)


def test_normal_stop_exits_zero(tmp_path: Path):
    """正常停机仍须以退出码 0 结束，否则下面的失败用例说明不了问题。"""
    result = _run_launcher(tmp_path, force_shutdown_failure=False)
    assert result.returncode == 0, result.stderr


def test_shutdown_write_failure_does_not_exit_zero(tmp_path: Path):
    """停机写回失败必须让进程以非零码结束。

    这正是 uvicorn 会吞掉的那条路径：它把 lifespan 的停机异常记成一行日志后正常
    返回，于是「写盘失败」曾经会被停机测试判成「正常停止」。
    """
    result = _run_launcher(tmp_path, force_shutdown_failure=True)
    assert result.returncode != 0, "停机写回失败却以退出码 0 结束"
    assert "停机失败" in result.stderr
    # 原始 traceback 要留在日志里，不能只留一句结论。
    assert "注入的停机写盘失败" in result.stderr
