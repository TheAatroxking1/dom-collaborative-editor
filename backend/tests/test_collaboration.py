"""协作房间与存储的生命周期。

这一层要保证的顺序与失败可见性：先恢复已有状态再开放同步、同一个文档只建一次
房间、目录有记录却没有数据时视为存储错误、正常停机把完整状态写回、失败时如实
报错而不是继续表现为健康服务。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from pycrdt import XmlFragment, XmlText
from pycrdt.store import SQLiteYStore

from app.collaboration import Collaboration, StorageUnavailable, read_document_state
from app.documents import SqliteDocumentDirectory, new_document_id


def run(coroutine):
    return asyncio.run(coroutine)


def write_into_first_paragraph(document, value: str) -> None:
    paragraph = document.get("body", type=XmlFragment).children[0]
    if len(paragraph.children) == 0:
        paragraph.children.append(XmlText())
    node = paragraph.children[0]
    node.insert(len(node), value)


def first_paragraph_text(document) -> str:
    paragraph = document.get("body", type=XmlFragment).children[0]
    return "".join(str(child) for child in paragraph.children)


def updates_path(data_directory: Path) -> Path:
    return data_directory / "updates.sqlite3"


# --- 房间初始化 -------------------------------------------------------------


def test_same_document_returns_the_same_room(data_directory: Path):
    async def scenario() -> None:
        collaboration = Collaboration(updates_path(data_directory))
        await collaboration.start()
        try:
            document_id = new_document_id()
            await collaboration.create_document_state(document_id)

            first = await collaboration.get_ready_room(document_id)
            second = await collaboration.get_ready_room(document_id)

            # 同一个文档绝不能加载出两份内存副本，否则两端会各写各的。
            assert first is second
            assert collaboration.loaded_documents() == [document_id]
        finally:
            await collaboration.close()

    run(scenario())


def test_room_reflects_stored_state(data_directory: Path):
    """旧状态必须在房间开放同步之前就已经恢复进 ydoc。"""

    async def scenario() -> None:
        first = Collaboration(updates_path(data_directory))
        await first.start()
        document_id = new_document_id()
        await first.create_document_state(document_id)
        room = await first.get_ready_room(document_id)
        write_into_first_paragraph(room.ydoc, "上一次写的内容")
        await first.close()

        second = Collaboration(updates_path(data_directory))
        await second.start()
        try:
            restored = await second.get_ready_room(document_id)
            assert first_paragraph_text(restored.ydoc) == "上一次写的内容"
        finally:
            await second.close()

    run(scenario())


def test_documents_are_isolated(data_directory: Path):
    async def scenario() -> None:
        collaboration = Collaboration(updates_path(data_directory))
        await collaboration.start()
        try:
            left_id = new_document_id()
            right_id = new_document_id()
            await collaboration.create_document_state(left_id)
            await collaboration.create_document_state(right_id)

            left = await collaboration.get_ready_room(left_id)
            right = await collaboration.get_ready_room(right_id)

            assert left is not right
            assert left.ystore is not right.ystore
            write_into_first_paragraph(left.ydoc, "只写左边")

            assert first_paragraph_text(left.ydoc) == "只写左边"
            assert first_paragraph_text(right.ydoc) == ""
        finally:
            await collaboration.close()

    run(scenario())


def test_missing_stored_state_is_a_storage_error(data_directory: Path):
    """目录里有记录却没有可恢复状态时，不能静默重新生成一份种子。"""

    async def scenario() -> None:
        directory = SqliteDocumentDirectory(data_directory / "documents.sqlite3")
        document_id = new_document_id()
        # 只登记目录，不写种子：模拟存储损坏或被误删。
        directory.create_document(document_id)

        collaboration = Collaboration(updates_path(data_directory))
        await collaboration.start()
        try:
            with pytest.raises(StorageUnavailable):
                await collaboration.get_ready_room(document_id)
            # 失败的房间不应留在可用列表里。
            assert collaboration.loaded_documents() == []
        finally:
            await collaboration.close()

    run(scenario())


# --- 停机 -------------------------------------------------------------------


def test_shutdown_writes_the_full_state(data_directory: Path):
    async def scenario() -> None:
        collaboration = Collaboration(updates_path(data_directory))
        await collaboration.start()
        document_id = new_document_id()
        await collaboration.create_document_state(document_id)
        room = await collaboration.get_ready_room(document_id)

        # 直接改 ydoc：写入是异步调度的，停机前不保证已经落盘。
        write_into_first_paragraph(room.ydoc, "停机前的内容")
        await collaboration.close()

        restored = await read_document_state(updates_path(data_directory), document_id)
        assert first_paragraph_text(restored) == "停机前的内容"

    run(scenario())


def test_shutdown_reports_write_failure(data_directory: Path):
    """停机写入失败必须抛出来，不能谎报保存成功。"""

    async def scenario() -> None:
        collaboration = Collaboration(updates_path(data_directory))
        await collaboration.start()
        document_id = new_document_id()
        await collaboration.create_document_state(document_id)
        room = await collaboration.get_ready_room(document_id)

        # 用一个必然失败的 store 替换掉：模拟停机时存储已经挂掉。
        class FailingStore:
            async def write(self, _data: bytes) -> None:
                raise RuntimeError("模拟磁盘故障")

        room.ystore = FailingStore()  # type: ignore[assignment]

        with pytest.raises(StorageUnavailable):
            await collaboration.close()
        assert collaboration.failures

    run(scenario())


def test_closing_twice_is_safe(data_directory: Path):
    async def scenario() -> None:
        collaboration = Collaboration(updates_path(data_directory))
        await collaboration.start()
        await collaboration.close()
        await collaboration.close()

    run(scenario())


def test_shutting_down_rejects_new_work(data_directory: Path):
    async def scenario() -> None:
        collaboration = Collaboration(updates_path(data_directory))
        await collaboration.start()
        document_id = new_document_id()
        await collaboration.create_document_state(document_id)
        await collaboration.close()

        assert collaboration.shutting_down
        with pytest.raises(StorageUnavailable):
            await collaboration.get_ready_room(document_id)
        with pytest.raises(StorageUnavailable):
            await collaboration.create_document_state(new_document_id())

    run(scenario())


# --- 存储故障 ---------------------------------------------------------------


def test_document_creation_reports_storage_failure(data_directory: Path):
    """存储不可用时创建文档要如实报错，不能返回一个打不开的文档。"""

    async def scenario() -> None:
        blocked = updates_path(data_directory)
        blocked.mkdir(parents=True)

        collaboration = Collaboration(blocked)
        with pytest.raises(StorageUnavailable):
            await collaboration.create_document_state(new_document_id())

    run(scenario())


def test_read_only_storage_does_not_publish_the_document(data_directory: Path):
    """只读数据库上创建文档必须报错。

    这是一个真实且容易漏掉的故障：库把 sqlite 异常交给 sqlite_anyio 的
    exception_logger，那个处理器返回 True（「已处理」），``async with`` 会正常
    退出。于是 ``store.write()`` 在没有真正写入的情况下静默返回，
    调用方如果只靠 try/except 就会把一个打不开的文档发布出去。
    """
    import stat

    async def scenario() -> None:
        path = updates_path(data_directory)
        path.parent.mkdir(parents=True, exist_ok=True)

        # 先正常建库并写入一个文档，确保数据库文件存在。
        collaboration = Collaboration(path)
        await collaboration.create_document_state(new_document_id())

        # 再把文件改成只读：读能成功，写会失败。
        path.chmod(stat.S_IREAD)
        try:
            with pytest.raises(StorageUnavailable):
                await collaboration.create_document_state(new_document_id())
        finally:
            path.chmod(stat.S_IWRITE | stat.S_IREAD)

    run(scenario())


def test_store_that_never_initializes_fails_fast_and_frees_the_lock(
    data_directory: Path,
):
    """后台初始化失败的 store 必须让前台尽快报错，而不是一直等下去。

    库的 ``start()`` 先置位 ``started``，``_init_db`` 在后台跑；后台失败时
    ``db_initialized`` 永不置位，任何 ``await`` 都会挂住。实现里用有界探针兜住，
    并且不能在挂住时还占着初始化锁——否则其他文档也一起被堵死。
    """

    async def scenario() -> None:
        class NeverInitializes(SQLiteYStore):
            db_path = str(updates_path(data_directory))

            async def _init_db(self) -> None:  # type: ignore[override]
                # 模拟后台初始化卡住：既不置位 db_initialized，也不返回。
                await asyncio.sleep(3600)

        collaboration = Collaboration(
            updates_path(data_directory), store_class=NeverInitializes
        )
        await collaboration.start()
        try:
            started = asyncio.get_running_loop().time()
            with pytest.raises(StorageUnavailable):
                await asyncio.wait_for(
                    collaboration.get_ready_room(new_document_id()), timeout=30
                )
            elapsed = asyncio.get_running_loop().time() - started
            # 必须在探针上限附近失败，而不是一直等下去。
            assert elapsed < 25

            # 失败没有把初始化锁占死：换一个正常的 store 类仍能建房间。
            healthy = Collaboration(updates_path(data_directory))
            await healthy.start()
            try:
                document_id = new_document_id()
                await healthy.create_document_state(document_id)
                room = await healthy.get_ready_room(document_id)
                assert room is not None
            finally:
                await healthy.close()
        finally:
            await collaboration.close()

    run(scenario())


def test_failed_create_leaves_no_open_store(data_directory: Path):
    """创建失败后不能留下后台任务或半开的数据库。"""

    async def scenario() -> None:
        blocked = updates_path(data_directory)
        blocked.mkdir(parents=True)

        collaboration = Collaboration(blocked)
        with pytest.raises(StorageUnavailable):
            await collaboration.create_document_state(new_document_id())
        assert collaboration.loaded_documents() == []

    run(scenario())


def test_read_document_state_reports_missing_content(data_directory: Path):
    async def scenario() -> None:
        with pytest.raises(StorageUnavailable):
            await read_document_state(updates_path(data_directory), new_document_id())

    run(scenario())


def test_store_class_does_not_mutate_the_library_default(data_directory: Path):
    """多个应用实例不能互相串库：不能改写库的全局类属性。"""
    from pycrdt.store import SQLiteYStore

    from app.collaboration import store_class_for

    default_path = SQLiteYStore.db_path
    first = store_class_for(data_directory / "a.sqlite3")
    second = store_class_for(data_directory / "b.sqlite3")

    assert first is not second
    assert first.db_path != second.db_path
    assert SQLiteYStore.db_path == default_path
