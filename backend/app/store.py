"""SQLite 文档日志与事务去重。

服务端只在提交成功后承认保存。这里把“文档元数据”“原始 CRDT 更新日志”和
“txId 去重记录”放在同一个数据库里，使一次提交要么整体生效，要么整体不生效。

每次操作都新建并关闭独立连接：SQLite 连接不是线程安全的，而所有写操作都会
通过 ``asyncio.to_thread`` 调度到线程池，复用连接会引入跨线程共享。
"""

from __future__ import annotations

import hashlib
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

#: 创建文档时写入的种子更新使用的固定标识。真实客户端事务使用 UUID，不会与它冲突。
SEED_TX_ID = "seed"

#: 数据库被其他连接持锁时等待的上限，超过则报告存储暂不可用。
BUSY_TIMEOUT_MS = 1000


class DocumentNotFound(LookupError):
    """请求的文档不存在。调用方不得据此隐式创建文档。"""

    def __init__(self, document_id: str) -> None:
        super().__init__(f"document not found: {document_id}")
        self.document_id = document_id


class TxPayloadMismatch(ValueError):
    """同一 txId 携带了与首次提交不同的内容，属于协议错误。"""

    def __init__(self, tx_id: str) -> None:
        super().__init__(f"payload mismatch for transaction: {tx_id}")
        self.tx_id = tx_id


class StorageUnavailable(RuntimeError):
    """底层数据库暂时不可用，调用方可保留队列后重试。"""

    def __init__(self, detail: str) -> None:
        super().__init__(f"storage unavailable: {detail}")
        self.detail = detail


@dataclass(frozen=True)
class DocumentMeta:
    document_id: str
    created_at: str


@dataclass(frozen=True)
class Receipt:
    tx_id: str
    seq: int
    duplicate: bool


@dataclass(frozen=True)
class StoredUpdate:
    tx_id: str
    seq: int
    payload: bytes


SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS updates (
  document_id TEXT NOT NULL REFERENCES documents(id),
  tx_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload BLOB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  PRIMARY KEY (document_id, tx_id),
  UNIQUE (document_id, seq)
);
"""


def _digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SqliteStore:
    """StoreContract 的 SQLite 实现。所有方法都是同步的，由调用方决定线程。"""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        # isolation_level=None 关闭隐式事务，写入路径显式使用 BEGIN IMMEDIATE，
        # 这样“检查去重键后写入”这组读改写始终处在同一个写事务里。
        connection = sqlite3.connect(self.path, isolation_level=None)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
            connection.execute("PRAGMA synchronous = FULL")
        except BaseException:
            connection.close()
            raise
        return connection

    def _initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = self._connect()
        try:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(SCHEMA)
        except sqlite3.Error as error:
            raise StorageUnavailable(str(error)) from error
        finally:
            connection.close()

    def create_document(self, initial_update: bytes) -> DocumentMeta:
        """创建文档并写入序号 0 的种子更新，两者在同一事务内提交。"""
        document_id = str(uuid.uuid4())
        created_at = _utc_now()
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT INTO documents(id, created_at, next_seq) VALUES (?, ?, ?)",
                (document_id, created_at, 1),
            )
            connection.execute(
                "INSERT INTO updates(document_id, tx_id, seq, payload, payload_sha256)"
                " VALUES (?, ?, ?, ?, ?)",
                (document_id, SEED_TX_ID, 0, initial_update, _digest(initial_update)),
            )
            connection.commit()
        except sqlite3.Error as error:
            connection.rollback()
            raise StorageUnavailable(str(error)) from error
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()
        return DocumentMeta(document_id=document_id, created_at=created_at)

    def get_document(self, document_id: str) -> DocumentMeta | None:
        connection = self._connect()
        try:
            row = connection.execute(
                "SELECT id, created_at FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
        except sqlite3.Error as error:
            raise StorageUnavailable(str(error)) from error
        finally:
            connection.close()
        if row is None:
            return None
        return DocumentMeta(document_id=row[0], created_at=row[1])

    def load_updates(self, document_id: str) -> list[StoredUpdate]:
        """按 seq 升序返回全部日志，用于重放重建文档。"""
        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT tx_id, seq, payload FROM updates WHERE document_id = ? ORDER BY seq ASC",
                (document_id,),
            ).fetchall()
        except sqlite3.Error as error:
            raise StorageUnavailable(str(error)) from error
        finally:
            connection.close()
        return [StoredUpdate(tx_id=row[0], seq=row[1], payload=row[2]) for row in rows]

    def lookup(self, document_id: str, tx_id: str, payload: bytes) -> Receipt | None:
        """查询事务是否已提交。摘要不一致说明 txId 被复用于不同内容。"""
        connection = self._connect()
        try:
            document = connection.execute(
                "SELECT 1 FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
            if document is None:
                raise DocumentNotFound(document_id)
            row = connection.execute(
                "SELECT seq, payload_sha256 FROM updates WHERE document_id = ? AND tx_id = ?",
                (document_id, tx_id),
            ).fetchone()
        except sqlite3.Error as error:
            raise StorageUnavailable(str(error)) from error
        finally:
            connection.close()
        if row is None:
            return None
        if row[1] != _digest(payload):
            raise TxPayloadMismatch(tx_id)
        return Receipt(tx_id=tx_id, seq=row[0], duplicate=True)

    def append(self, document_id: str, tx_id: str, payload: bytes) -> Receipt:
        """追加一条更新。重试相同 txId 与内容时返回原序号且不重复写入。"""
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            result = self._append_in_transaction(connection, document_id, tx_id, payload)
            connection.commit()
        except sqlite3.Error as error:
            connection.rollback()
            raise StorageUnavailable(str(error)) from error
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()
        return result

    @staticmethod
    def _append_in_transaction(
        connection: sqlite3.Connection, document_id: str, tx_id: str, payload: bytes
    ) -> Receipt:
        """在已开启的写事务内完成去重检查与追加。不自行提交。"""
        digest = _digest(payload)
        document = connection.execute(
            "SELECT next_seq FROM documents WHERE id = ?", (document_id,)
        ).fetchone()
        if document is None:
            raise DocumentNotFound(document_id)

        previous = connection.execute(
            "SELECT seq, payload_sha256 FROM updates WHERE document_id = ? AND tx_id = ?",
            (document_id, tx_id),
        ).fetchone()
        if previous is not None:
            if previous[1] != digest:
                raise TxPayloadMismatch(tx_id)
            return Receipt(tx_id=tx_id, seq=previous[0], duplicate=True)

        seq = document[0]
        connection.execute(
            "INSERT INTO updates(document_id, tx_id, seq, payload, payload_sha256)"
            " VALUES (?, ?, ?, ?, ?)",
            (document_id, tx_id, seq, payload, digest),
        )
        connection.execute(
            "UPDATE documents SET next_seq = ? WHERE id = ?", (seq + 1, document_id)
        )
        return Receipt(tx_id=tx_id, seq=seq, duplicate=False)
