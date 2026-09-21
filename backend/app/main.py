"""FastAPI 应用工厂：文档 HTTP 接口与 WebSocket 同步入口。

导入本模块不连接也不修改数据库：建表与房间恢复都推迟到 lifespan 启动阶段，
这样测试可以在导入后再决定数据库路径。
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from pathlib import Path
from uuid import UUID

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from . import protocol
from .crdt import new_document
from .protocol import (
    ErrorCode,
    Hello,
    ProtocolError,
    SyncEnd,
    Transaction,
    encode_error,
)
from .room import Peer, Room, RoomHooks, RoomManager, RoomUnavailable
from .store import DocumentNotFound, SqliteStore, StorageUnavailable

DEFAULT_DATABASE_PATH = "backend/data/collab.db"

#: 关闭码 1013「稍后再试」：慢连接被服务端主动断开，由客户端重连补同步。
SLOW_CONSUMER_CLOSE_CODE = 1013


def _document_id_from_path(raw: str) -> str:
    try:
        return str(UUID(raw))
    except (ValueError, AttributeError, TypeError) as error:
        raise ProtocolError(ErrorCode.DOCUMENT_NOT_FOUND, "文档标识不是有效 UUID") from error


async def _send_error(websocket: WebSocket, sync_id: str, document_id: str, error: ProtocolError) -> None:
    with contextlib.suppress(RuntimeError):
        await websocket.send_text(
            encode_error(document_id, sync_id, error.code, error.message, error.retryable)
        )


async def _writer(websocket: WebSocket, room: Room, peer: Peer, document_id: str) -> None:
    """该连接唯一的发送协程。hook 在此调用，因此不持有房间锁。"""
    try:
        while True:
            frame = await peer.outgoing.get()
            if frame.kind == "sync":
                await room.hooks.before_sync_send(document_id, peer.sync_id)
            elif frame.kind == "ack" and frame.tx_id is not None:
                await room.hooks.before_ack_send(document_id, frame.tx_id)
            await websocket.send_text(frame.text)
    except (WebSocketDisconnect, RuntimeError):
        # 对端已经离开；读取循环会走自己的清理路径。
        return


async def _watch_overflow(websocket: WebSocket, peer: Peer) -> None:
    """发送队列溢出时关闭该慢连接；其他连接不受影响。"""
    await peer.overflow_event.wait()
    with contextlib.suppress(RuntimeError):
        await websocket.close(code=SLOW_CONSUMER_CLOSE_CODE)


def create_app(
    database_path: Path | str, hooks: RoomHooks | None = None
) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.database_path = Path(database_path)
        app.state.store = SqliteStore(app.state.database_path)
        app.state.rooms = RoomManager(app.state.store, hooks)
        try:
            yield
        finally:
            app.state.rooms = None
            app.state.store = None

    app = FastAPI(title="DOM 协同编辑器同步服务", lifespan=lifespan)

    def _store(request: Request) -> SqliteStore:
        return request.app.state.store

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/documents", status_code=201)
    def create_document(request: Request) -> JSONResponse:
        try:
            meta = _store(request).create_document(new_document().get_update())
        except StorageUnavailable as error:
            return JSONResponse(
                status_code=503, content={"error": "STORAGE_UNAVAILABLE", "message": error.detail}
            )
        return JSONResponse(
            status_code=201,
            content={"documentId": meta.document_id, "createdAt": meta.created_at},
        )

    @app.get("/api/documents/{document_id}")
    def read_document(document_id: str, request: Request) -> JSONResponse:
        try:
            normalized = _document_id_from_path(document_id)
        except ProtocolError:
            return JSONResponse(status_code=404, content={"error": "DOCUMENT_NOT_FOUND"})
        try:
            meta = _store(request).get_document(normalized)
        except StorageUnavailable as error:
            return JSONResponse(
                status_code=503, content={"error": "STORAGE_UNAVAILABLE", "message": error.detail}
            )
        if meta is None:
            return JSONResponse(status_code=404, content={"error": "DOCUMENT_NOT_FOUND"})
        return JSONResponse(
            content={"documentId": meta.document_id, "createdAt": meta.created_at}
        )

    @app.websocket("/ws/documents/{document_id}")
    async def document_socket(websocket: WebSocket, document_id: str) -> None:
        await websocket.accept()
        rooms: RoomManager = websocket.app.state.rooms

        try:
            normalized = _document_id_from_path(document_id)
        except ProtocolError as error:
            await _send_error(websocket, protocol.NIL_SYNC_ID, document_id, error)
            await websocket.close()
            return

        # 首帧必须是 hello：在此之前不登记订阅，也不接受任何写入。
        try:
            first = protocol.parse_client_message(await websocket.receive_text())
        except WebSocketDisconnect:
            return
        except ProtocolError as error:
            await _send_error(websocket, protocol.NIL_SYNC_ID, normalized, error)
            await websocket.close()
            return

        if not isinstance(first, Hello):
            await _send_error(
                websocket,
                protocol.NIL_SYNC_ID,
                normalized,
                ProtocolError(ErrorCode.BAD_MESSAGE, "首帧必须是 hello"),
            )
            await websocket.close()
            return

        if first.document_id != normalized:
            await _send_error(
                websocket,
                first.sync_id,
                normalized,
                ProtocolError(ErrorCode.BAD_MESSAGE, "路径与消息中的文档标识不一致"),
            )
            await websocket.close()
            return

        try:
            room = await rooms.get(normalized)
        except DocumentNotFound:
            await _send_error(
                websocket,
                first.sync_id,
                normalized,
                ProtocolError(ErrorCode.DOCUMENT_NOT_FOUND, "文档不存在"),
            )
            await websocket.close()
            return
        except StorageUnavailable as error:
            await _send_error(
                websocket,
                first.sync_id,
                normalized,
                ProtocolError(ErrorCode.STORAGE_UNAVAILABLE, error.detail),
            )
            await websocket.close()
            return

        peer = Peer(first.sync_id)
        active_sync_id = first.sync_id

        try:
            await room.join(peer, first.state_vector)
        except RoomUnavailable as error:
            await _send_error(
                websocket,
                active_sync_id,
                normalized,
                ProtocolError(ErrorCode.ROOM_UNAVAILABLE, str(error)),
            )
            await websocket.close()
            return

        writer_task = asyncio.create_task(_writer(websocket, room, peer, normalized))
        overflow_task = asyncio.create_task(_watch_overflow(websocket, peer))

        try:
            while True:
                try:
                    frame = protocol.parse_client_message(await websocket.receive_text())
                except ProtocolError as error:
                    # 无效帧明确报错，并关闭连接而不是继续盲目重试同一消息。
                    await _send_error(websocket, active_sync_id, normalized, error)
                    await websocket.close()
                    return

                if frame.sync_id != active_sync_id:
                    # 一个连接只绑定一个 syncId；切换标识会让确认与状态归属错乱。
                    await _send_error(
                        websocket,
                        active_sync_id,
                        normalized,
                        ProtocolError(ErrorCode.BAD_MESSAGE, "连接内不得切换 syncId"),
                    )
                    await websocket.close()
                    return

                if isinstance(frame, Hello):
                    await _send_error(
                        websocket,
                        active_sync_id,
                        normalized,
                        ProtocolError(ErrorCode.BAD_MESSAGE, "连接内不得重复 hello"),
                    )
                    await websocket.close()
                    return

                try:
                    await _dispatch(room, peer, frame)
                except ProtocolError as error:
                    await _send_error(websocket, active_sync_id, normalized, error)
                    if not error.retryable:
                        await websocket.close()
                        return
                    if error.code is ErrorCode.ROOM_UNAVAILABLE:
                        await websocket.close()
                        return
        except WebSocketDisconnect:
            pass
        finally:
            writer_task.cancel()
            overflow_task.cancel()
            for task in (writer_task, overflow_task):
                with contextlib.suppress(asyncio.CancelledError, RuntimeError):
                    await task
            await room.leave(peer)

    return app


async def _dispatch(room: Room, peer: Peer, frame: Transaction | SyncEnd) -> None:
    if isinstance(frame, Transaction):
        await room.submit(peer, frame.tx_id, frame.update)
    else:
        await room.barrier(peer, frame.barrier_id)


app = create_app(Path(os.environ.get("COLLAB_DB_PATH", DEFAULT_DATABASE_PATH)))
