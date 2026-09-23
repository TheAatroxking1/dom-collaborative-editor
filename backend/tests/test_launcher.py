"""测试启动器的停机竞态判定。

这个判定决定了「uvicorn 停机时抛出的连接拆除异常」算不算正常停止，写错就会把真实
失败一起吞掉，所以单独固定它的边界。
"""

from __future__ import annotations

import pytest

from tests.uvicorn_launcher import is_connection_teardown_race


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
