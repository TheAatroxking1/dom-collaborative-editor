"""后端测试共享夹具。"""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def data_directory(tmp_path: Path) -> Path:
    """每个测试独占一个数据目录，避免共享状态掩盖隔离缺陷。

    目录里会有两个独立数据库：文档目录与 CRDT 存储。
    """
    return tmp_path / "data"
