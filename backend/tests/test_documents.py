"""文档目录与服务端种子。

目录只保存元数据；正文由库的存储负责，两者是不同文件。这一层要保证的是：
种子唯一、文档标识唯一、未知文档明确不存在，以及目录故障时如实报错。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pycrdt import XmlElement, XmlFragment

from app.documents import (
    DirectoryUnavailable,
    SqliteDocumentDirectory,
    new_document_id,
    new_seed_document,
)


@pytest.fixture
def directory(data_directory: Path) -> SqliteDocumentDirectory:
    return SqliteDocumentDirectory(data_directory / "documents.sqlite3")


def test_seed_has_exactly_one_empty_paragraph():
    document = new_seed_document()
    fragment = document.get("body", type=XmlFragment)
    assert len(fragment.children) == 1
    assert fragment.children[0].tag == "paragraph"
    assert len(fragment.children[0].children) == 0


def test_seed_uses_the_shared_body_field_name():
    """前后端必须使用同一个字段名，写错会表现为「编辑器永远是空的」。"""
    assert new_seed_document().get("body", type=XmlFragment) is not None


def test_two_seeds_do_not_share_state():
    first = new_seed_document()
    second = new_seed_document()
    first.get("body", type=XmlFragment).children.append(XmlElement("paragraph"))
    assert len(second.get("body", type=XmlFragment).children) == 1


def test_document_ids_are_uuid4_and_unique():
    identifiers = {new_document_id() for _ in range(50)}
    assert len(identifiers) == 50


def test_create_and_read_document(directory: SqliteDocumentDirectory):
    document_id = new_document_id()
    created = directory.create_document(document_id)

    assert created.document_id == document_id
    assert created.created_at
    assert directory.get_document(document_id) == created


def test_unknown_document_is_none(directory: SqliteDocumentDirectory):
    assert directory.get_document(new_document_id()) is None


def test_directory_persists_across_instances(data_directory: Path):
    path = data_directory / "documents.sqlite3"
    document_id = new_document_id()
    SqliteDocumentDirectory(path).create_document(document_id)
    assert SqliteDocumentDirectory(path).get_document(document_id) is not None


def test_duplicate_registration_is_rejected(directory: SqliteDocumentDirectory):
    document_id = new_document_id()
    directory.create_document(document_id)
    with pytest.raises(DirectoryUnavailable):
        directory.create_document(document_id)


def test_directory_failure_is_reported(data_directory: Path):
    """把目录文件的位置占成目录，构造时必须如实报错而不是静默继续。"""
    blocked = data_directory / "documents.sqlite3"
    blocked.mkdir(parents=True)
    with pytest.raises(DirectoryUnavailable):
        SqliteDocumentDirectory(blocked)


def test_documents_are_isolated(directory: SqliteDocumentDirectory):
    left = new_document_id()
    right = new_document_id()
    directory.create_document(left)

    assert directory.get_document(left) is not None
    assert directory.get_document(right) is None
