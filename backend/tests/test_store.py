"""SQLite 文档日志：原子提交、去重、隔离与恢复。"""

from __future__ import annotations

import sqlite3
import threading
import uuid
from pathlib import Path

import pytest

from app.crdt import new_document, restore_document
from app.store import (
    SEED_TX_ID,
    DocumentNotFound,
    Receipt,
    SqliteStore,
    StorageUnavailable,
    TxPayloadMismatch,
)


def seed_update() -> bytes:
    return new_document().get_update()


def test_retry_is_durable_and_idempotent(database_path: Path):
    store = SqliteStore(database_path)
    meta = store.create_document(seed_update())
    tx_id = str(uuid.uuid4())
    first = store.append(meta.document_id, tx_id, b"payload-one")
    retry = SqliteStore(database_path).append(meta.document_id, tx_id, b"payload-one")
    assert retry.seq == first.seq
    assert retry.duplicate
    rows = SqliteStore(database_path).load_updates(meta.document_id)
    assert sum(row.tx_id == tx_id for row in rows) == 1
    with pytest.raises(TxPayloadMismatch):
        store.append(meta.document_id, tx_id, b"payload-two")


def test_lookup_reports_existing_and_missing_transactions(store: SqliteStore):
    meta = store.create_document(seed_update())
    tx_id = str(uuid.uuid4())
    assert store.lookup(meta.document_id, tx_id, b"payload") is None
    appended = store.append(meta.document_id, tx_id, b"payload")
    found = store.lookup(meta.document_id, tx_id, b"payload")
    assert found == Receipt(tx_id=tx_id, seq=appended.seq, duplicate=True)
    with pytest.raises(TxPayloadMismatch):
        store.lookup(meta.document_id, tx_id, b"other")


def test_create_document_persists_seed_at_sequence_zero(store: SqliteStore):
    seed = seed_update()
    meta = store.create_document(seed)
    rows = store.load_updates(meta.document_id)
    assert [(row.tx_id, row.seq) for row in rows] == [(SEED_TX_ID, 0)]
    assert rows[0].payload == seed
    assert store.get_document(meta.document_id) == meta


def test_unknown_document_is_not_created(store: SqliteStore):
    missing = str(uuid.uuid4())
    assert store.get_document(missing) is None
    with pytest.raises(DocumentNotFound):
        store.append(missing, str(uuid.uuid4()), b"payload")
    with pytest.raises(DocumentNotFound):
        store.lookup(missing, str(uuid.uuid4()), b"payload")
    assert store.get_document(missing) is None


def test_same_tx_id_in_different_documents_stays_isolated(store: SqliteStore):
    first = store.create_document(seed_update())
    second = store.create_document(seed_update())
    tx_id = str(uuid.uuid4())

    left = store.append(first.document_id, tx_id, b"left-payload")
    right = store.append(second.document_id, tx_id, b"right-payload")

    assert left.seq == right.seq == 1
    assert not left.duplicate and not right.duplicate
    assert [row.payload for row in store.load_updates(first.document_id)][1:] == [b"left-payload"]
    assert [row.payload for row in store.load_updates(second.document_id)][1:] == [b"right-payload"]


def test_failed_append_leaves_no_partial_record(store: SqliteStore):
    meta = store.create_document(seed_update())
    tx_id = str(uuid.uuid4())
    store.append(meta.document_id, tx_id, b"first")
    with pytest.raises(TxPayloadMismatch):
        store.append(meta.document_id, tx_id, b"second")

    rows = store.load_updates(meta.document_id)
    assert [row.seq for row in rows] == [0, 1]
    # 失败的写入不得消耗序号：下一条新事务仍然拿到 seq 2。
    assert store.append(meta.document_id, str(uuid.uuid4()), b"third").seq == 2


def test_next_sequence_is_monotonic_across_reload(database_path: Path):
    store = SqliteStore(database_path)
    meta = store.create_document(seed_update())
    for index in range(3):
        store.append(meta.document_id, str(uuid.uuid4()), f"payload-{index}".encode())

    reloaded = SqliteStore(database_path)
    rows = reloaded.load_updates(meta.document_id)
    assert [row.seq for row in rows] == [0, 1, 2, 3]
    assert reloaded.append(meta.document_id, str(uuid.uuid4()), b"later").seq == 4


def test_concurrent_appends_get_unique_sequences(database_path: Path):
    store = SqliteStore(database_path)
    meta = store.create_document(seed_update())

    receipts: list[Receipt] = []
    failures: list[BaseException] = []
    lock = threading.Lock()
    start = threading.Barrier(4)

    def worker(index: int) -> None:
        start.wait()
        try:
            receipt = SqliteStore(database_path).append(
                meta.document_id, str(uuid.uuid4()), f"payload-{index}".encode()
            )
        except BaseException as error:  # noqa: BLE001 - 竞争失败也属预期，稍后断言其类型
            with lock:
                failures.append(error)
            return
        with lock:
            receipts.append(receipt)

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    # 竞争可能触发锁等待超时，但绝不允许出现重复或错误的序号。
    assert all(isinstance(error, StorageUnavailable) for error in failures)
    sequences = sorted(receipt.seq for receipt in receipts)
    assert len(set(sequences)) == len(sequences)
    assert sequences == list(range(1, len(receipts) + 1))


def test_write_lock_reports_storage_unavailable(database_path: Path):
    store = SqliteStore(database_path)
    meta = store.create_document(seed_update())

    holder = sqlite3.connect(database_path, isolation_level=None)
    try:
        holder.execute("PRAGMA busy_timeout = 1000")
        holder.execute("BEGIN IMMEDIATE")
        with pytest.raises(StorageUnavailable):
            store.append(meta.document_id, str(uuid.uuid4()), b"blocked")
    finally:
        holder.rollback()
        holder.close()

    # 锁释放后同一实例仍可正常提交，队列不需要重建。
    assert store.append(meta.document_id, str(uuid.uuid4()), b"after-release").seq == 1


def test_replaying_log_rebuilds_committed_crdt(store: SqliteStore):
    from pycrdt import Doc, Text

    meta = store.create_document(seed_update())

    source = restore_document([store.load_updates(meta.document_id)[0].payload])
    source.get("probe", type=Text).insert(0, "日志恢复🙂")
    store.append(meta.document_id, str(uuid.uuid4()), source.get_update())

    rebuilt = restore_document([row.payload for row in store.load_updates(meta.document_id)])
    assert str(rebuilt.get("probe", type=Text)) == "日志恢复🙂"

    fresh = Doc()
    fresh.apply_update(rebuilt.get_update())
    assert str(fresh.get("probe", type=Text)) == "日志恢复🙂"
