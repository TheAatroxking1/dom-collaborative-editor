"""后端测试共享夹具。"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.store import SqliteStore


@pytest.fixture
def database_path(tmp_path: Path) -> Path:
    """每个测试独占一个临时数据库，避免共享状态掩盖隔离缺陷。"""
    return tmp_path / "collab.db"


@pytest.fixture
def store(database_path: Path) -> SqliteStore:
    return SqliteStore(database_path)
