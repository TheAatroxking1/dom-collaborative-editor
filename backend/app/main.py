"""FastAPI 应用工厂：文档接口、标准 Yjs WebSocket 入口，以及可选的静态页面服务。

FastAPI 在这里只承担四件事：文档目录接口、WebSocket 前的存在性校验、把连接交给库
处理，以及在显式配置时把构建好的前端资源一并提供出去。协议、合并、广播与持久化都
不在本文件内实现。

导入本模块不连接也不创建数据库：目录与存储都推迟到 lifespan 启动阶段，
这样测试可以在导入之后再决定数据目录。
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from pathlib import Path
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse
from starlette.staticfiles import StaticFiles

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

#: 静态入口占用的路径前缀。这些前缀永远不交给静态文件处理。
RESERVED_PREFIXES = ("api", "ws")


def normalize_document_id(raw: str) -> str | None:
    """把路径里的文档标识规范化为标准 UUID 字符串。

    规范化后用作房间键，避免 URL 前缀或大小写差异产生重复房间。
    """
    try:
        return str(UUID(raw))
    except (ValueError, AttributeError, TypeError):
        return None


def create_app(
    data_directory: Path | str = DEFAULT_DATA_DIRECTORY,
    *,
    static_directory: Path | str | None = None,
) -> FastAPI:
    data_path = Path(data_directory)

    # 静态目录在构造时就解析并校验：显式配置了不存在的目录应当立刻失败，
    # 而不是等到第一个请求才发现页面打不开。
    static_root: Path | None = None
    if static_directory is not None:
        static_root = Path(static_directory).resolve()
        if not static_root.is_dir():
            raise NotADirectoryError(
                f"静态目录不存在或不是目录（未执行构建？）：{static_root}"
            )

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

    # --- 可选的静态页面服务 -------------------------------------------------
    #
    # 注册在所有 API/WS 路由之后，只处理 GET/HEAD。刻意不做「任意路径回退到
    # index.html」：hash 路由只需要请求根路径，而全站回退会把拼错的资源路径和
    # 未知 API 变成 200 HTML，掩盖真实错误。
    if static_root is not None:
        static_files = StaticFiles(directory=str(static_root), html=True)

        @app.api_route(
            "/{asset_path:path}", methods=["GET", "HEAD"], include_in_schema=False
        )
        async def frontend_asset(asset_path: str, request: Request):
            # api/ws 前缀永远不属于静态资源，即使目录里恰好有同名文件。
            if asset_path in RESERVED_PREFIXES or asset_path.startswith(
                tuple(f"{prefix}/" for prefix in RESERVED_PREFIXES)
            ):
                raise HTTPException(status_code=404)
            try:
                response = await static_files.get_response(asset_path or ".", request.scope)
            except Exception as error:  # noqa: BLE001 - 统一转成 404，不泄漏内部路径
                raise HTTPException(status_code=404) from error
            # 页面与 SW 每次都要回源校验，否则浏览器可能一直用旧外壳；
            # 构建产物带内容哈希，可以长期缓存。
            response.headers["Cache-Control"] = (
                "public, max-age=31536000, immutable"
                if asset_path.startswith("assets/")
                else "no-cache"
            )
            return response

    return app


app = create_app(
    Path(os.environ.get("COLLAB_DATA_DIR", DEFAULT_DATA_DIRECTORY)),
    static_directory=os.environ.get("COLLAB_STATIC_DIR") or None,
)
