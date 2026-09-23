"""文档目录与服务端种子构造。

目录只记录 ``documentId`` 与创建时间，正文不在这里维护：正文由库的 CRDT 存储
负责，两者使用不同的数据库文件，应用不读写库的内部表结构。

种子只在创建文档时由服务端写入一次并持久化。浏览器不会各自补一份默认段落，
因此不存在重复初始化。
"""

from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from pycrdt import Doc, XmlElement, XmlFragment

#: 正文使用的 Y.XmlFragment 名称，前后端必须一致。
BODY_FIELD = "body"
PARAGRAPH_TAG = "paragraph"

#: 目录数据库被其他连接持锁时等待的上限。
BUSY_TIMEOUT_MS = 1000

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
"""


class DirectoryUnavailable(RuntimeError):
    """目录数据库暂时不可用，调用方应返回 503。"""

    def __init__(self, detail: str) -> None:
        super().__init__(f"document directory unavailable: {detail}")
        self.detail = detail


@dataclass(frozen=True)
class DocumentMeta:
    document_id: str
    created_at: str


def new_document_id() -> str:
    return str(uuid.uuid4())


def new_seed_document() -> Doc:
    """构造只含一个空段落的文档，用作服务端唯一种子。"""
    document = Doc()
    root = document.get(BODY_FIELD, type=XmlFragment)
    root.children.append(XmlElement(PARAGRAPH_TAG))
    return document


class SqliteDocumentDirectory:
    """文档目录。只保存元数据，不保存正文。

    每个操作使用独立连接：调用方会通过 ``asyncio.to_thread`` 调度到线程池，
    复用连接会引入跨线程共享。
    """

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, isolation_level=None)
        try:
            connection.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
        except BaseException:
            connection.close()
            raise
        return connection

    def _initialize(self) -> None:
        # 建目录、建连接、建表任意一步失败都要转成目录不可用：
        # 调用方只需要区分「目录能用」和「目录不能用」两种情况。
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            connection = self._connect()
        except sqlite3.Error as error:
            raise DirectoryUnavailable(str(error)) from error
        try:
            connection.executescript(SCHEMA)
        except sqlite3.Error as error:
            raise DirectoryUnavailable(str(error)) from error
        finally:
            connection.close()

    def create_document(self, document_id: str) -> DocumentMeta:
        """登记一个已经写好种子的文档。

        调用方必须先把种子写进 CRDT 存储；这里只负责让文档变得「可见」，
        因此写入失败的文档不会留下可被打开的目录记录。
        """
        created_at = datetime.now(timezone.utc).isoformat()
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT INTO documents(id, created_at) VALUES (?, ?)",
                (document_id, created_at),
            )
            connection.commit()
        except sqlite3.IntegrityError as error:
            connection.rollback()
            raise DirectoryUnavailable(f"文档已存在：{document_id}") from error
        except sqlite3.Error as error:
            connection.rollback()
            raise DirectoryUnavailable(str(error)) from error
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
            raise DirectoryUnavailable(str(error)) from error
        finally:
            connection.close()
        if row is None:
            return None
        return DocumentMeta(document_id=row[0], created_at=row[1])
