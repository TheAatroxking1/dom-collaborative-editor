"""FastAPI 应用工厂：文档接口与标准 Yjs WebSocket 入口。

FastAPI 在这里只承担三件事：文档目录接口、WebSocket 前的存在性校验、以及把连接
交给库处理。协议、合并、广播与持久化都不在本文件内实现。

导入本模块不连接也不创建数据库：目录与存储都推迟到 lifespan 启动阶段，
这样测试可以在导入之后再决定数据目录。
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from pathlib import Path
from uuid import UUID

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse

from .collaboration import Collaboration, StorageUnavailable
from .documents import (
    DirectoryUnavailable,
    SqliteDocumentDirectory,
    new_document_id,
)

DEFAULT_DATA_DIRECTORY = "backend/data/v2"
DIRECTORY_FILENAME = "documents.sqlite3"
UPDATES_FILENAME = "updates.sqlite3"

#: 文档不存在。浏览器据此停止本次打开流程，而不是无限重连。
CLOSE_DOCUMENT_NOT_FOUND = 4404
#: 服务暂时不可用（存储故障或正在停机），可稍后重试。
CLOSE_TRY_AGAIN_LATER = 1013


def normalize_document_id(raw: str) -> str | None:
    """把路径里的文档标识规范化为标准 UUID 字符串。

    规范化后用作房间键，避免 URL 前缀或大小写差异产生重复房间。
    """
    try:
        return str(UUID(raw))
    except (ValueError, AttributeError, TypeError):
        return None


def create_app(data_directory: Path | str = DEFAULT_DATA_DIRECTORY) -> FastAPI:
    data_path = Path(data_directory)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.documents = SqliteDocumentDirectory(data_path / DIRECTORY_FILENAME)
        app.state.collaboration = Collaboration(data_path / UPDATES_FILENAME)
        await app.state.collaboration.start()
        try:
            yield
        finally:
            await app.state.collaboration.close()
            app.state.collaboration = None
            app.state.documents = None

    app = FastAPI(title="DOM 协同编辑器同步服务", lifespan=lifespan)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        # 只说明进程存活，不声称所有文档的存储都健康。
        return {"status": "ok"}

    @app.post("/api/documents", status_code=201)
    async def create_document(request: Request) -> JSONResponse:
        document_id = new_document_id()
        collaboration: Collaboration = request.app.state.collaboration
        directory: SqliteDocumentDirectory = request.app.state.documents

        # 先写种子，成功后才登记目录：写失败的文档不会变成可打开的半成品。
        try:
            await collaboration.create_document_state(document_id)
        except StorageUnavailable as error:
            return JSONResponse(
                status_code=503,
                content={"error": "STORAGE_UNAVAILABLE", "message": error.detail},
            )

        try:
            meta = await asyncio.to_thread(directory.create_document, document_id)
        except DirectoryUnavailable as error:
            return JSONResponse(
                status_code=503,
                content={"error": "STORAGE_UNAVAILABLE", "message": error.detail},
            )
        return JSONResponse(
            status_code=201,
            content={"documentId": meta.document_id, "createdAt": meta.created_at},
        )

    @app.get("/api/documents/{document_id}")
    async def read_document(document_id: str, request: Request) -> JSONResponse:
        normalized = normalize_document_id(document_id)
        if normalized is None:
            return JSONResponse(status_code=404, content={"error": "DOCUMENT_NOT_FOUND"})
        directory: SqliteDocumentDirectory = request.app.state.documents
        try:
            meta = await asyncio.to_thread(directory.get_document, normalized)
        except DirectoryUnavailable as error:
            return JSONResponse(
                status_code=503,
                content={"error": "STORAGE_UNAVAILABLE", "message": error.detail},
            )
        if meta is None:
            return JSONResponse(status_code=404, content={"error": "DOCUMENT_NOT_FOUND"})
        return JSONResponse(
            content={"documentId": meta.document_id, "createdAt": meta.created_at}
        )

    @app.websocket("/ws/documents/{document_id}")
    async def document_socket(websocket: WebSocket, document_id: str) -> None:
        collaboration: Collaboration | None = websocket.app.state.collaboration
        directory: SqliteDocumentDirectory | None = websocket.app.state.documents

        async def reject(code: int) -> None:
            # 必须先 accept 再 close，浏览器才收得到自定义关闭码。
            # 这条路径不创建房间、不进入 serve。
            await websocket.accept()
            await websocket.close(code=code)

        if collaboration is None or directory is None or collaboration.shutting_down:
            await reject(CLOSE_TRY_AGAIN_LATER)
            return

        normalized = normalize_document_id(document_id)
        if normalized is None:
            await reject(CLOSE_DOCUMENT_NOT_FOUND)
            return

        try:
            meta = await asyncio.to_thread(directory.get_document, normalized)
        except DirectoryUnavailable:
            await reject(CLOSE_TRY_AGAIN_LATER)
            return
        if meta is None:
            await reject(CLOSE_DOCUMENT_NOT_FOUND)
            return

        # 状态恢复完成之前不接受这条连接；失败时明确拒绝而不是给一个空文档。
        try:
            await collaboration.get_ready_room(normalized)
        except StorageUnavailable:
            await reject(CLOSE_TRY_AGAIN_LATER)
            return

        await websocket.accept()
        await collaboration.serve(normalized, websocket)

    return app


app = create_app(Path(os.environ.get("COLLAB_DATA_DIR", DEFAULT_DATA_DIRECTORY)))
