"""用现成库承载协作房间、持久化与 WebSocket 接入。

这里只做三件事：组装库对象、保证「先恢复再开放同步」的顺序、以及正常停机时
把完整状态写回存储。合并、广播、awareness 转发、二进制协议解析与增量写入全部
由 pycrdt-websocket 与 pycrdt-store 完成。

刻意不实现的东西：消息编解码、发送队列、事务标识、确认语义、握手屏障、
候选文档克隆、逐更新的落盘回执。库不提供的保存承诺，这里也不会伪装提供。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from functools import partial
from pathlib import Path
from typing import Any

from pycrdt import Doc, create_awareness_message
from pycrdt.store import SQLiteYStore, YDocNotFound
from pycrdt.websocket import WebsocketServer, YRoom

# ASGIWebsocket 没有从包顶层导出，需要从子模块取。
from pycrdt.websocket.asgi_server import ASGIWebsocket

from .documents import BODY_FIELD, new_seed_document  # noqa: F401  (BODY_FIELD 供调用方引用)

#: 停机时单个文档写完整状态的等待上限。超时说明存储已不可用，必须如实上报。
SHUTDOWN_WRITE_TIMEOUT_SECONDS = 10.0

#: 等待 store 初始化完成的上限。
#:
#: 库的 ``start()`` 会先把 ``started`` 置位，``_init_db`` 在后台任务里跑；后台失败
#: 时 ``db_initialized`` 永远不会置位，任何 ``await`` 都会一直挂住。所以这里用有界
#: 探针确认存储真的可用，而不是无限等待。
STORE_START_TIMEOUT_SECONDS = 10.0


class StorageUnavailable(RuntimeError):
    """CRDT 存储不可用：调用方应返回 503 或关闭码 1013。"""

    def __init__(self, detail: str) -> None:
        super().__init__(f"storage unavailable: {detail}")
        self.detail = detail


def store_class_for(database_path: Path) -> type[SQLiteYStore]:
    """为给定数据库文件生成 store 子类。

    ``db_path`` 是类属性，所以每次生成一个新的子类而不是改写库的全局类属性：
    同一个进程里跑多个应用实例时不会互相串库。
    """

    class _DocumentStore(SQLiteYStore):
        db_path = str(database_path)

    return _DocumentStore


async def _apply_store_state(document: Doc, store: SQLiteYStore) -> bool:
    """把存储里的更新重放进文档。返回是否读到过内容。

    与 ``_probe_store`` 同理：异常路径上也要显式关闭生成器，否则会把库内部的锁留下。
    """
    applied = False
    iterator = store.read()
    try:
        async for update, _metadata, _timestamp in iterator:
            document.apply_update(update)
            applied = True
    except YDocNotFound:
        return False
    finally:
        with contextlib.suppress(Exception):
            await iterator.aclose()
    return applied


async def _probe_store(store: SQLiteYStore) -> None:
    """确认 store 真的可用。

    空存储会抛 ``YDocNotFound``，这是正常情况；初始化失败时库会让这一步一直挂住，
    由调用方用超时兜住。

    必须显式关闭这个异步生成器：库的 ``read()`` 在内部持有锁，提前 ``return`` 会把
    生成器连同已获取的锁一起留下，之后所有读写都会报「当前任务未持有该锁」，
    而 ``read()`` 又把这个异常转成 ``YDocNotFound``，表现为「存储里什么都没有」。
    """
    iterator = store.read()
    try:
        async for _update, _metadata, _timestamp in iterator:
            return
    except YDocNotFound:
        return
    finally:
        with contextlib.suppress(Exception):
            await iterator.aclose()


async def _store_holds_state(store: SQLiteYStore, document: Doc) -> bool:
    """确认存储里的内容与给定文档完全一致。

    这里刻意**不**比较状态向量：删除操作不推进客户端时钟，所以「内存里删了、
    存储里没删」时两边状态向量完全相同，只比较状态向量会把漏写判定成成功。

    也不比较单向或双向差量：``get_update(state)`` 总会带上删除集，只要文档有过
    删除，差量就非空，无法用来判断「是否一致」。

    实际采用全量编码的字节比较，它同时覆盖结构体与删除集。编码器对同一份历史
    （相同的结构体与删除集）产出相同字节，无论这些更新当初是分几条写入的。
    """
    restored = Doc()
    if not await _apply_store_state(restored, store):
        return False
    return restored.get_update() == document.get_update()


async def read_document_state(database_path: Path, document_id: str) -> Doc:
    """用官方 store 直接读取某个文档的状态。

    这是验证手段：证明正文确实落在数据库里，而不是靠内存或客户端补传。
    任何失败都归为存储不可用——调用方只需要知道「读得到」还是「读不到」。
    """
    database_path = Path(database_path)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    store = store_class_for(database_path)(path=document_id)
    try:
        async with store:
            document = Doc()
            if not await _apply_store_state(document, store):
                raise StorageUnavailable(f"存储中没有 {document_id} 的内容")
            return document
    except StorageUnavailable:
        raise
    except Exception as error:  # noqa: BLE001 - 统一转成存储不可用
        raise StorageUnavailable(str(error)) from error


class Collaboration:
    """协作房间与存储的生命周期管理。"""

    def __init__(
        self,
        database_path: Path | str,
        log: logging.Logger | None = None,
        store_class: type[SQLiteYStore] | None = None,
    ) -> None:
        self.database_path = Path(database_path)
        # store_class 是给测试用的注入口：生产路径永远走 store_class_for。
        self._store_class = store_class or store_class_for(self.database_path)
        self._log = log or logging.getLogger("collab")
        self._server = WebsocketServer(
            # 房间初始不 ready：状态恢复完成前不向客户端同步。
            rooms_ready=False,
            # 最后一个客户端离开时不取消可能仍在进行的写入。
            auto_clean_rooms=False,
            exception_handler=None,
            log=self._log,
        )
        self._stores: dict[str, SQLiteYStore] = {}
        self._store_tasks: dict[str, asyncio.Task[None]] = {}
        self._init_lock = asyncio.Lock()
        self._failed_documents: dict[str, str] = {}
        self._shutting_down = False
        self._started = False
        self.failures: list[str] = []

    # --- 生命周期 ---------------------------------------------------------

    async def start(self) -> None:
        # store 只负责文件本身，不会创建父目录，这里在启动时确保数据目录存在。
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        await self._server.__aenter__()
        self._started = True

    async def close(self) -> None:
        """正常停机：停止接客与消息处理 → 写完整状态 → 关闭 room/store/server。

        ``stop`` 不能当作写入排空，因此这里显式补一次完整状态写入，并给等待设上限。
        失败必须可见：不谎报保存成功。
        """
        if not self._started:
            return
        self._shutting_down = True
        self._started = False

        await self._server.__aexit__(None, None, None)

        failures = await self._flush_rooms()
        self.failures.extend(failures)

        for document_id in list(self._stores):
            await self._close_store(document_id)

        if failures:
            raise StorageUnavailable("停机时写入失败：" + "；".join(failures))

    async def _flush_rooms(self) -> list[str]:
        failures: list[str] = []
        for document_id, room in list(self._server.rooms.items()):
            store = room.ystore
            if store is None:
                continue
            document = room.ydoc
            try:
                # 与创建文档同理：库会静默吞掉 sqlite 异常，write() 返回不代表写成功。
                # 必须在写入后回读比对，否则停机时会把「没写进去」记录成写入成功。
                await asyncio.wait_for(
                    store.write(document.get_update()),
                    timeout=SHUTDOWN_WRITE_TIMEOUT_SECONDS,
                )
                if not await asyncio.wait_for(
                    _store_holds_state(store, document),
                    timeout=SHUTDOWN_WRITE_TIMEOUT_SECONDS,
                ):
                    raise RuntimeError("写入后读回的状态与内存不一致，最新修改没有落盘")
                self._log.info("停机已写入文档 %s", document_id)
            except TimeoutError:
                message = f"{document_id}：写入或校验超时（{SHUTDOWN_WRITE_TIMEOUT_SECONDS} 秒）"
                failures.append(message)
                self._log.error("停机写入超时：%s", document_id)
            except Exception as error:  # noqa: BLE001 - 任何写入失败都要上报
                message = f"{document_id}：{error}"
                failures.append(message)
                self._log.error("停机写入失败：%s -> %s", document_id, error)
        return failures

    @property
    def shutting_down(self) -> bool:
        return self._shutting_down

    def loaded_documents(self) -> list[str]:
        return list(self._server.rooms)

    # --- 文档创建 ---------------------------------------------------------

    async def create_document_state(self, document_id: str) -> None:
        """写入唯一的空段落种子，并确认它真的落盘了。

        必须先成功返回，调用方才可以把文档登记进目录；失败时文档对客户端不可见，
        不会出现「能打开但正文是半初始化」的文档。

        这里必须回读确认，而不是只等 ``write()`` 返回：库把 sqlite 的异常交给了
        ``sqlite_anyio.exception_logger``，那个处理器返回 True 表示「已处理」，
        ``async with`` 会正常退出。也就是说 SQL 失败（例如库被锁、文件只读）会被
        静默吞掉，只靠 try/except 捕获不到。
        """
        if self._shutting_down:
            raise StorageUnavailable("服务正在关闭")

        store = self._store_class(path=document_id)
        try:
            async with store:
                await store.write(new_seed_document().get_update())
                stored = await asyncio.wait_for(
                    _apply_store_state(Doc(), store), timeout=STORE_START_TIMEOUT_SECONDS
                )
                if not stored:
                    # 写调用没抛错，但读回来是空的：种子没有落盘，不能发布这个文档。
                    raise StorageUnavailable("种子写入后读不回内容，存储可能不可写")
        except StorageUnavailable:
            raise
        except Exception as error:  # noqa: BLE001 - 统一转成存储不可用
            raise StorageUnavailable(str(error)) from error

    # --- 房间 -------------------------------------------------------------

    async def get_ready_room(self, document_id: str) -> YRoom:
        """返回已完成状态恢复的房间。

        顺序是硬性的：先恢复已有状态，再标记 ready（这一步才会装上观察器开始
        广播与写入），最后等待观察器就绪。接客顺序由这里保证，库的 ``ready=False``
        本身不会拦截 ``serve``。
        """
        if self._shutting_down:
            raise StorageUnavailable("服务正在关闭")

        room = self._server.rooms.get(document_id)
        if room is not None and document_id not in self._failed_documents:
            return room

        async with self._init_lock:
            room = self._server.rooms.get(document_id)
            if room is not None and document_id not in self._failed_documents:
                return room
            # 上一轮失败的房间已经停止服务，这里重建一份，避免一直卡在失败状态。
            self._failed_documents.pop(document_id, None)
            room = await self._build_room(document_id)
            self._server.rooms[document_id] = room
            return room

    async def _build_room(self, document_id: str) -> YRoom:
        store = await self._open_store(document_id)
        room = YRoom(
            ready=False,
            ystore=store,
            exception_handler=partial(self._handle_room_exception, document_id),
            log=self._log,
        )
        try:
            restored = await _apply_store_state(room.ydoc, store)
            if not restored:
                # 目录里有记录却没有可恢复状态，属于存储错误。
                # 不能静默重新生成种子：那会让两个客户端拿到不同的空段落。
                raise StorageUnavailable(f"目录中存在 {document_id}，但存储里没有可恢复的状态")
            await self._server.start_room(room)
            room.ready = True
            await room.ydoc_observed.wait()
        except BaseException:
            await self._close_store(document_id)
            raise
        self._log.info("文档 %s 已恢复并就绪", document_id)
        return room

    async def serve(self, document_id: str, websocket: Any) -> None:
        """把 FastAPI 的 WebSocket 交给库的标准 Channel 适配。

        只做收发与断开转换，不解析 Yjs 消息；accept 由调用方完成，这里不重复接受。
        """
        channel = ASGIWebsocket(websocket.receive, websocket.send, document_id)
        # 先补齐已有的临时状态，再进入库的服务循环。
        await self._send_current_awareness(document_id, channel)
        await self._server.serve(channel)

    async def _send_current_awareness(self, document_id: str, channel: Any) -> None:
        """把房间里已有的 Awareness 状态补给这条新连接。

        库只在 awareness **发生变化**时广播。新加入的连接自己不携带别人的状态，服务端
        的状态也没变，于是一直到别人下次移动鼠标或改选区之前什么都收不到——表现为
        「后加入的设备看不到已有光标和框选，过一会儿才冒出来」。

        这里主动把当前快照发给它。发不出去不影响后续服务：这条连接会在库的循环里
        正常收发。
        """
        room = self._server.rooms.get(document_id)
        if room is None:
            return
        client_ids = list(room.awareness.states)
        if not client_ids:
            return
        try:
            update = room.awareness.encode_awareness_update(client_ids)
            await channel.send(create_awareness_message(update))
        except Exception as error:  # noqa: BLE001 - 补发失败不该影响连接本身
            self._log.warning("补发文档 %s 的 awareness 失败：%s", document_id, error)

    # --- 存储与失败处理 ---------------------------------------------------

    async def _open_store(self, document_id: str) -> SQLiteYStore:
        """启动一个文档的 store，并确认它真的可用。

        这里刻意不用 ``async with store``：房间是随连接按需创建的，而 store 的
        ``__aexit__`` 必须与 ``__aenter__`` 在同一个任务里执行，否则 anyio 会拒绝
        退出别的任务创建的取消作用域。改用低层 ``start()/stop()``，自己持有一个
        任务，启动与停止就不再和调用者绑在同一个任务上。

        也不能只等 ``started``：库会先置位它，再在后台跑 ``_init_db``；后台失败时
        ``db_initialized`` 永不置位，前台会一直等待，还会一直占着初始化锁把其他
        文档也堵住。所以这里用有界探针。
        """
        existing = self._stores.get(document_id)
        if existing is not None:
            return existing
        if self._shutting_down:
            raise StorageUnavailable("服务正在关闭")

        store = self._store_class(path=document_id)
        task = asyncio.create_task(store.start())
        try:
            await store.started.wait()
            await asyncio.wait_for(
                _probe_store(store), timeout=STORE_START_TIMEOUT_SECONDS
            )
        except (Exception, asyncio.CancelledError) as error:
            await self._discard_store(store, task)
            if isinstance(error, asyncio.CancelledError):
                raise
            raise StorageUnavailable(f"存储无法启动：{error}") from error

        self._stores[document_id] = store
        self._store_tasks[document_id] = task
        return store

    async def _discard_store(
        self, store: SQLiteYStore, task: asyncio.Task[None]
    ) -> None:
        """丢弃一个启动失败的 store，确保不留下后台任务或半开的数据库。"""
        task.cancel()
        with contextlib.suppress(BaseException):
            await task
        # 失败路径上 store 可能从未真正跑起来，stop() 会报「未运行」，忽略即可。
        with contextlib.suppress(BaseException):
            await store.stop()

    async def _close_store(self, document_id: str) -> None:
        store = self._stores.pop(document_id, None)
        task = self._store_tasks.pop(document_id, None)
        if store is None:
            return
        try:
            await store.stop()
        except Exception as error:  # noqa: BLE001 - 关闭失败只记录，不掩盖主流程
            self._log.error("停止 %s 的 store 失败：%s", document_id, error)
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    def _handle_room_exception(
        self, document_id: str, exception: Exception, log: logging.Logger
    ) -> bool:
        """记录房间异常并让它继续传播。

        返回 False 表示「未处理」，任务组会因此取消该房间、断开连接。这里刻意不
        吞掉错误：数据库写失败后继续对外表现为健康服务，比直接失败更糟。
        """
        log.error("文档 %s 的房间发生错误，已停止该房间：%s", document_id, exception)
        self._failed_documents[document_id] = str(exception)
        self.failures.append(f"{document_id}：{exception}")
        return False
