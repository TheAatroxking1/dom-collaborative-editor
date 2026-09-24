"""可选静态目录：一个端口同时提供页面资源与 API/WebSocket。

未配置静态目录时行为与之前完全一致；配置后也只增加 GET/HEAD 的静态入口，
不改变 API、WebSocket 与协作逻辑。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


def make_dist(root: Path, *, index_html: str = "<main>offline shell</main>") -> Path:
    dist = root / "dist"
    (dist / "assets").mkdir(parents=True, exist_ok=True)
    (dist / "index.html").write_text(index_html, encoding="utf-8")
    (dist / "sw.js").write_text("// service worker", encoding="utf-8")
    (dist / "assets" / "app-test.js").write_text("console.log('app')", encoding="utf-8")
    return dist


@pytest.fixture
def static_app(tmp_path: Path):
    dist = make_dist(tmp_path)
    with TestClient(create_app(tmp_path / "data", static_directory=dist)) as client:
        yield client, dist


def test_root_serves_index(static_app):
    client, _ = static_app
    response = client.get("/")
    assert response.status_code == 200
    assert "offline shell" in response.text
    assert client.head("/").status_code == 200


def test_unknown_api_is_not_html(static_app):
    """未知 API 路径必须是 404，不能被静态入口或 fallback 变成 HTML。"""
    client, _ = static_app
    response = client.get("/api/not-a-route")
    assert response.status_code == 404
    assert "offline shell" not in response.text


def test_unknown_ws_is_not_html(static_app):
    client, _ = static_app
    response = client.get("/ws/not-a-route")
    assert response.status_code == 404
    assert "offline shell" not in response.text


def test_missing_asset_is_404(static_app):
    client, _ = static_app
    response = client.get("/missing.js")
    assert response.status_code == 404
    assert "offline shell" not in response.text


def test_health_still_works(static_app):
    client, _ = static_app
    assert client.get("/api/health").json() == {"status": "ok"}


def test_document_api_still_works(static_app):
    client, _ = static_app
    created = client.post("/api/documents")
    assert created.status_code == 201
    document_id = created.json()["documentId"]
    assert client.get(f"/api/documents/{document_id}").status_code == 200


def test_cache_headers(static_app):
    """index 与 sw 每次都要回源校验，哈希资源可以长期缓存。"""
    client, _ = static_app

    index = client.get("/")
    assert index.headers["cache-control"] == "no-cache"
    assert client.get("/sw.js").headers["cache-control"] == "no-cache"
    assert (
        client.get("/assets/app-test.js").headers["cache-control"]
        == "public, max-age=31536000, immutable"
    )


def test_no_path_traversal(static_app, tmp_path: Path):
    """不能用 ../ 读到 dist 之外的文件。"""
    client, dist = static_app
    secret = tmp_path / "secret.txt"
    secret.write_text("不该被读到", encoding="utf-8")

    for attempt in ("/../secret.txt", "/..%2Fsecret.txt", "/%2e%2e/secret.txt"):
        response = client.get(attempt)
        assert "不该被读到" not in response.text


def test_api_prefix_is_not_served_statically(static_app):
    """api/ws 前缀即使是真实存在的目录也不走静态入口。"""
    client, dist = static_app
    (dist / "api").mkdir(exist_ok=True)
    (dist / "api" / "notes.txt").write_text("静态目录里的文件", encoding="utf-8")

    response = client.get("/api/notes.txt")
    assert response.status_code == 404
    assert "静态目录里的文件" not in response.text


def test_only_get_and_head_are_accepted(static_app):
    client, _ = static_app
    assert client.post("/").status_code in (404, 405)


def test_app_without_static_directory_does_not_need_dist(tmp_path: Path):
    """未配置静态目录时仍是纯 API/WS 服务，不要求 dist 存在。"""
    with TestClient(create_app(tmp_path / "data")) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        assert client.post("/api/documents").status_code == 201
        assert client.get("/").status_code == 404


def test_missing_static_directory_fails_clearly(tmp_path: Path):
    """显式配置了不存在的目录时，启动必须清晰失败而不是静默忽略。"""
    missing = tmp_path / "not-built"
    with pytest.raises(Exception) as info:
        with TestClient(create_app(tmp_path / "data", static_directory=missing)):
            pass
    assert "not-built" in str(info.value) or "directory" in str(info.value).lower()


def test_websocket_still_connects_with_static_directory(tmp_path: Path):
    """静态入口不得影响协作 WebSocket。"""
    from pycrdt import (
        Doc,
        XmlFragment,
        YMessageType,
        YSyncMessageType,
        create_sync_message,
        handle_sync_message,
    )

    dist = make_dist(tmp_path)
    with TestClient(create_app(tmp_path / "data", static_directory=dist)) as client:
        document_id = client.post("/api/documents").json()["documentId"]
        with client.websocket_connect(f"/ws/documents/{document_id}") as socket:
            doc = Doc()
            socket.send_bytes(create_sync_message(doc))
            # 按帧类型握手，不假定帧数：服务器可能先补发一帧 awareness。
            for _ in range(5):
                raw = socket.receive_bytes()
                if not raw or raw[0] != YMessageType.SYNC:
                    continue
                reply = handle_sync_message(raw[1:], doc)
                if reply is not None:
                    socket.send_bytes(reply)
                if raw[1] == YSyncMessageType.SYNC_STEP2:
                    break
            assert len(doc.get("body", type=XmlFragment).children) == 1


def test_unknown_websocket_path_is_rejected(tmp_path: Path):
    """未知 WS 路径要被正常拒绝，而不是让静态子应用抛断言错误。"""
    dist = make_dist(tmp_path)
    with TestClient(create_app(tmp_path / "data", static_directory=dist)) as client:
        with pytest.raises(Exception):
            with client.websocket_connect("/ws/not-a-document"):
                pass
