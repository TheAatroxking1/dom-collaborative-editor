"""单文档串行房间：订阅、提交、确认与恢复。

一个 Room 代表一个文档的实时状态。所有会改变房间状态的操作都在同一把
``asyncio.Lock`` 内完成，因此“登记订阅并读取差量”“去重检查并提交”这类读改写
不会与其他连接交错。

锁内只做内存操作与存储调用，不等待网络发送：待发消息进入各连接自己的有界
FIFO，由该连接唯一的 writer 协程取出。这样慢连接不会阻塞整个房间。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Literal, Protocol

from pycrdt import Doc, XmlFragment

from .crdt import candidate_document, restore_document
from .protocol import (
    MAX_OUTGOING_FRAMES,
    MAX_UPDATE_BYTES,
    ErrorCode,
    ProtocolError,
    encode_ack,
    encode_ready,
    encode_sync,
    encode_update,
)
from .store import DocumentNotFound, Receipt, StorageUnavailable, TxPayloadMismatch


class RoomHooks:
    """房间扩展点。生产默认全是空操作，只有测试会注入实现来制造故障窗口。

    ``after_commit`` 在房间锁内、数据库提交之后调用，可用于复现“已落盘但尚未
    广播”的崩溃窗口。

    ``before_sync_send`` 与 ``before_ack_send`` 在连接 writer 内调用，此时不持有
    房间锁，因此可以在其中暂停某一条连接而不影响其他连接继续提交。
    """

    async def after_commit(self, document_id: str, tx_id: str, seq: int) -> None:
        return None

    async def before_sync_send(self, document_id: str, sync_id: str) -> None:
        return None

    async def before_ack_send(self, document_id: str, tx_id: str) -> None:
        return None


@dataclass(frozen=True)
class Frame:
    """待发送的一帧。kind 决定 writer 在真正发送前调用哪个 hook。"""

    kind: Literal["sync", "update", "ack", "ready"]
    text: str
    tx_id: str | None = None


class Peer:
    """一个实时订阅者。每个连接只有一个 writer 协程从 outgoing 取帧。"""

    def __init__(self, sync_id: str) -> None:
        self.sync_id = sync_id
        self.outgoing: asyncio.Queue[Frame] = asyncio.Queue(maxsize=MAX_OUTGOING_FRAMES)
        self.overflowed = False
        #: 队列溢出时置位，由该连接的监视协程负责关闭套接字。
        self.overflow_event = asyncio.Event()

    def enqueue(self, frame: Frame) -> bool:
        """非阻塞入队。队列满时标记溢出，由 handler 关闭该慢连接。"""
        try:
            self.outgoing.put_nowait(frame)
        except asyncio.QueueFull:
            self.overflowed = True
            self.overflow_event.set()
            return False
        return True


class RoomUnavailable(RuntimeError):
    """房间正在从持久化日志重建，期间拒绝新写入。"""


class StoreContract(Protocol):
    def load_updates(self, document_id: str) -> list: ...
    def lookup(self, document_id: str, tx_id: str, payload: bytes) -> Receipt | None: ...
    def append(self, document_id: str, tx_id: str, payload: bytes) -> Receipt: ...


class Room:
    def __init__(
        self, document_id: str, store: StoreContract, hooks: RoomHooks | None = None
    ) -> None:
        self.document_id = document_id
        self.store = store
        self.hooks = hooks or RoomHooks()
        self.lock = asyncio.Lock()
        self.peers: dict[str, Peer] = {}
        self.doc: Doc | None = None
        self.seq = -1
        self.available = False

    async def load(self) -> None:
        """从持久化日志重建房间。必须先于任何握手或写入完成。"""
        async with self.lock:
            await self._reload_locked()

    async def _reload_locked(self) -> None:
        updates = await asyncio.to_thread(self.store.load_updates, self.document_id)
        if not updates:
            raise DocumentNotFound(self.document_id)
        self.doc = restore_document([row.payload for row in updates])
        self.seq = max(row.seq for row in updates)
        self.available = True

    async def join(self, peer: Peer, state_vector: bytes) -> None:
        """登记订阅并排入初始同步响应。

        登记与读取差量处在同一个锁区间内，因此不存在“取完差量、订阅之前”这段
        会丢失更新的空档。
        """
        async with self.lock:
            if not self.available or self.doc is None:
                raise RoomUnavailable(self.document_id)
            self.peers[peer.sync_id] = peer
            update = self.doc.get_update(state_vector)
            peer.enqueue(
                Frame(
                    kind="sync",
                    text=encode_sync(
                        self.document_id, peer.sync_id, update, self.doc.get_state(), self.seq
                    ),
                )
            )

    async def submit(self, peer: Peer, tx_id: str, payload: bytes) -> Receipt:
        """提交一个可重试事务。

        顺序固定为：去重 → 候选校验 → 落盘 → 广播 → 确认。任何一步失败都不会
        走到广播与 ACK，因此客户端不会看到未持久化的“已保存”。
        """
        async with self.lock:
            if not self.available or self.doc is None:
                raise RoomUnavailable(self.document_id)
            if len(payload) > MAX_UPDATE_BYTES:
                raise ProtocolError(ErrorCode.UPDATE_TOO_LARGE, "更新超过大小上限")

            try:
                receipt = await asyncio.to_thread(
                    self.store.lookup, self.document_id, tx_id, payload
                )
            except TxPayloadMismatch as error:
                raise ProtocolError(
                    ErrorCode.TX_PAYLOAD_MISMATCH, "同一 txId 携带了不同内容"
                ) from error
            except StorageUnavailable as error:
                raise ProtocolError(ErrorCode.STORAGE_UNAVAILABLE, error.detail) from error

            if receipt is None:
                receipt = await self._commit_locked(peer, tx_id, payload)

            self._enqueue_ack(peer, receipt)
            return receipt

    async def _commit_locked(self, peer: Peer, tx_id: str, payload: bytes) -> Receipt:
        try:
            candidate = candidate_document(self.doc, payload)
        except ValueError as error:
            raise ProtocolError(ErrorCode.INVALID_UPDATE, "更新无法解码或应用") from error

        if len(candidate.get_update()) > MAX_UPDATE_BYTES:
            raise ProtocolError(ErrorCode.UPDATE_TOO_LARGE, "候选文档超过大小上限")

        try:
            receipt = await asyncio.to_thread(
                self.store.append, self.document_id, tx_id, payload
            )
        except TxPayloadMismatch as error:
            raise ProtocolError(
                ErrorCode.TX_PAYLOAD_MISMATCH, "同一 txId 携带了不同内容"
            ) from error
        except DocumentNotFound as error:
            raise ProtocolError(ErrorCode.DOCUMENT_NOT_FOUND, "文档不存在") from error
        except StorageUnavailable as error:
            raise ProtocolError(ErrorCode.STORAGE_UNAVAILABLE, error.detail) from error

        await self.hooks.after_commit(self.document_id, receipt.tx_id, receipt.seq)

        try:
            # 替换必须在锁内完成：否则并发的 join 可能读到落后的内存状态。
            self.doc = candidate
            self.seq = receipt.seq
            # 提交者已经拥有该内容，且会收到 ACK，因此广播时排除它自己。
            self._broadcast_locked(payload, receipt.seq, exclude=peer.sync_id)
        except BaseException:
            # 已落盘但内存发布失败：暂停房间并从日志重建，绝不能用落后的内存
            # 状态继续服务新请求。
            self.available = False
            await self._reload_locked()
            raise

        return receipt

    def _broadcast_locked(self, payload: bytes, seq: int, exclude: str | None) -> None:
        for sync_id, peer in self.peers.items():
            if sync_id == exclude:
                continue
            peer.enqueue(
                Frame(
                    kind="update",
                    text=encode_update(self.document_id, sync_id, payload, seq),
                )
            )

    def _enqueue_ack(self, peer: Peer, receipt: Receipt) -> None:
        peer.enqueue(
            Frame(
                kind="ack",
                text=encode_ack(self.document_id, peer.sync_id, receipt.tx_id, receipt.seq),
                tx_id=receipt.tx_id,
            )
        )

    async def barrier(self, peer: Peer, barrier_id: str) -> None:
        """同步屏障：确认此前已入队的同步事务都处理完毕。"""
        async with self.lock:
            if not self.available:
                raise RoomUnavailable(self.document_id)
            peer.enqueue(
                Frame(
                    kind="ready",
                    text=encode_ready(self.document_id, peer.sync_id, barrier_id, self.seq),
                )
            )

    async def leave(self, peer: Peer) -> None:
        async with self.lock:
            self.peers.pop(peer.sync_id, None)


class RoomManager:
    """按 documentId 复用房间，避免并发请求加载出两个内存副本。"""

    def __init__(self, store: StoreContract, hooks: RoomHooks | None = None) -> None:
        self._store = store
        self._hooks = hooks or RoomHooks()
        self._rooms: dict[str, Room] = {}
        self._guard = asyncio.Lock()

    async def get(self, document_id: str) -> Room:
        async with self._guard:
            room = self._rooms.get(document_id)
            if room is None:
                room = Room(document_id, self._store, self._hooks)
                await room.load()
                self._rooms[document_id] = room
            return room

    async def drop(self, document_id: str) -> None:
        async with self._guard:
            self._rooms.pop(document_id, None)

    def loaded_documents(self) -> list[str]:
        return list(self._rooms)


def body_fragment(doc: Doc) -> XmlFragment:
    return doc.get("body", type=XmlFragment)
