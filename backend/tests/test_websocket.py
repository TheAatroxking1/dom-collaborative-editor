"""真实 ASGI 接口：文档 HTTP、WebSocket 握手、提交、广播与故障语义。

测试客户端从握手拿到服务端种子，而不是自己造一份同样的默认正文——这与浏览器
的实际路径一致，也避免掩盖“两端各自初始化”这类缺陷。
"""

from __future__ import annotations

import asyncio
import base64
import json
import sqlite3
import threading
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pycrdt import XmlFragment

from app.crdt import restore_document
from app.main import create_app
from app.protocol import MAX_OUTGOING_FRAMES, PROTOCOL_VERSION, ErrorCode
from app.room import RoomHooks
from app.store import SqliteStore, StorageUnavailable


def ws_url(document_id: str) -> str:
    return f"/ws/documents/{document_id}"


def hello_frame(document_id: str, sync_id: str, state_vector: bytes) -> str:
    return json.dumps(
        {
            "v": PROTOCOL_VERSION,
            "type": "hello",
            "documentId": document_id,
            "syncId": sync_id,
            "stateVector": base64.b64encode(state_vector).decode("ascii"),
        }
    )


def tx_frame(
    document_id: str, sync_id: str, tx_id: str, update: bytes, kind: str = "edit"
) -> str:
    return json.dumps(
        {
            "v": PROTOCOL_VERSION,
            "type": "tx",
            "documentId": document_id,
            "syncId": sync_id,
            "txId": tx_id,
            "kind": kind,
            "update": base64.b64encode(update).decode("ascii"),
        }
    )


def sync_end_frame(document_id: str, sync_id: str, barrier_id: str) -> str:
    return json.dumps(
        {
            "v": PROTOCOL_VERSION,
            "type": "sync-end",
            "documentId": document_id,
            "syncId": sync_id,
            "barrierId": barrier_id,
        }
    )


class Client:
    """模拟一个浏览器副本：从握手取得种子，只发送对端缺失的差量。"""

    def __init__(self, socket, document_id: str) -> None:
        self.socket = socket
        self.document_id = document_id
        self.sync_id = str(uuid.uuid4())
        self.doc = restore_document([])
        # 客户端认为服务端已拥有的状态；只有收到确认才推进。
        self.confirmed_state = self.doc.get_state()

    def send(self, payload: str) -> None:
        self.socket.send_text(payload)

    def receive(self) -> dict:
        return json.loads(self.socket.receive_text())

    def apply(self, message: dict) -> None:
        if "update" in message:
            self.doc.apply_update(base64.b64decode(message["update"]))

    def handshake(self) -> dict:
        self.send(hello_frame(self.document_id, self.sync_id, self.doc.get_state()))
        message = self.receive()
        assert message["type"] == "sync", message
        self.apply(message)
        self.confirmed_state = self.doc.get_state()
        return message

    def paragraph(self):
        fragment = self.doc.get("body", type=XmlFragment)
        assert len(fragment.children) == 1, "正文应有且只有一个段落"
        return fragment.children[0]

    def text(self) -> str:
        paragraph = self.paragraph()
        return "".join(str(child) for child in paragraph.children)

    def write(self, text: str) -> None:
        """像用户输入那样在正文首段追加文字。"""
        from pycrdt import XmlText

        paragraph = self.paragraph()
        if len(paragraph.children) == 0:
            paragraph.children.append(XmlText())
        node = paragraph.children[0]
        node.insert(len(node), text)

    def erase(self, start: int, length: int) -> None:
        """按索引删除正文文字。测试只用 ASCII 内容，避开 pycrdt 的多字节索引缺陷。"""
        node = self.paragraph().children[0]
        del node[start : start + length]

    def submit(self, tx_id: str | None = None, kind: str = "edit") -> tuple[str, dict]:
        tx_id = tx_id or str(uuid.uuid4())
        payload = self.doc.get_update(self.confirmed_state)
        self.send(tx_frame(self.document_id, self.sync_id, tx_id, payload, kind))
        message = self.receive()
        assert message["type"] == "ack", message
        self.confirmed_state = self.doc.get_state()
        return tx_id, message


def read_document_text(document_id: str, path: Path) -> str:
    """用独立连接读日志重建文档，不依赖内存房间状态。"""
    rows = SqliteStore(path).load_updates(document_id)
    rebuilt = restore_document([row.payload for row in rows])
    fragment = rebuilt.get("body", type=XmlFragment)
    return "\n".join(
        "".join(str(child) for child in paragraph.children) for paragraph in fragment.children
    )


def new_document_id(client: TestClient) -> str:
    created = client.post("/api/documents")
    assert created.status_code == 201
    return created.json()["documentId"]


# --- HTTP -------------------------------------------------------------------


def test_create_document_is_persistent(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        created = client.post("/api/documents")
        assert created.status_code == 201
        document_id = created.json()["documentId"]
        assert created.json()["createdAt"]
    with TestClient(create_app(database_path)) as client:
        reread = client.get(f"/api/documents/{document_id}")
        assert reread.status_code == 200
        assert reread.json()["documentId"] == document_id


def test_unknown_document_is_not_created(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        assert client.get("/api/documents/00000000-0000-4000-8000-000000000001").status_code == 404
        assert client.get("/api/documents/not-a-uuid").status_code == 404


def test_health(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        assert client.get("/api/health").json() == {"status": "ok"}


def test_creating_app_does_not_touch_database(database_path: Path):
    """构造应用只记录路径，建表推迟到 lifespan 内。"""
    never = database_path / "never-created.db"
    create_app(never)
    assert not never.exists()


# --- WebSocket 握手 ---------------------------------------------------------


def test_first_frame_must_be_hello(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as socket:
            socket.send_text(
                tx_frame(document_id, str(uuid.uuid4()), str(uuid.uuid4()), b"\x00")
            )
            error = json.loads(socket.receive_text())
            assert error["type"] == "error"
            assert error["code"] == ErrorCode.BAD_MESSAGE.value
            assert error["retryable"] is False


def test_unknown_document_is_rejected_without_creating_it(database_path: Path):
    missing = str(uuid.uuid4())
    with TestClient(create_app(database_path)) as client:
        with client.websocket_connect(ws_url(missing)) as socket:
            socket.send_text(hello_frame(missing, str(uuid.uuid4()), b"\x00"))
            error = json.loads(socket.receive_text())
            assert error["code"] == ErrorCode.DOCUMENT_NOT_FOUND.value
            assert error["retryable"] is False
        assert client.get(f"/api/documents/{missing}").status_code == 404
    assert SqliteStore(database_path).get_document(missing) is None


def test_path_and_message_document_must_agree(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        first = new_document_id(client)
        second = new_document_id(client)
        with client.websocket_connect(ws_url(first)) as socket:
            socket.send_text(hello_frame(second, str(uuid.uuid4()), b"\x00"))
            error = json.loads(socket.receive_text())
            assert error["code"] == ErrorCode.BAD_MESSAGE.value


def test_unsupported_version_is_reported(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as socket:
            socket.send_text(
                json.dumps(
                    {
                        "v": PROTOCOL_VERSION + 1,
                        "type": "hello",
                        "documentId": document_id,
                        "syncId": str(uuid.uuid4()),
                        "stateVector": "",
                    }
                )
            )
            error = json.loads(socket.receive_text())
            assert error["code"] == ErrorCode.UNSUPPORTED_VERSION.value


def test_malformed_document_path_is_rejected(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        with client.websocket_connect(ws_url("not-a-uuid")) as socket:
            error = json.loads(socket.receive_text())
            assert error["code"] == ErrorCode.DOCUMENT_NOT_FOUND.value


def test_sync_id_cannot_change_within_a_connection(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as socket:
            peer = Client(socket, document_id)
            peer.handshake()
            socket.send_text(
                tx_frame(document_id, str(uuid.uuid4()), str(uuid.uuid4()), b"\x00")
            )
            error = json.loads(socket.receive_text())
            assert error["code"] == ErrorCode.BAD_MESSAGE.value


def test_hello_delivers_server_seed_paragraph(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as socket:
            peer = Client(socket, document_id)
            synced = peer.handshake()
            fragment = peer.doc.get("body", type=XmlFragment)
            assert len(fragment.children) == 1
            assert fragment.children[0].tag == "paragraph"
            assert len(fragment.children[0].children) == 0
            assert synced["seq"] == 0


# --- 提交、广播与确认 -------------------------------------------------------


def test_commit_is_broadcast_to_the_other_browser(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as first_socket:
            with client.websocket_connect(ws_url(document_id)) as second_socket:
                first = Client(first_socket, document_id)
                second = Client(second_socket, document_id)
                first.handshake()
                second.handshake()

                first.write("你好")
                _, ack = first.submit()

                broadcast = second.receive()
                assert broadcast["type"] == "update"
                assert broadcast["seq"] == ack["seq"]
                second.apply(broadcast)

                assert second.text() == "你好"
                assert read_document_text(document_id, database_path) == "你好"


def test_ack_means_the_update_is_in_sqlite(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as socket:
            peer = Client(socket, document_id)
            peer.handshake()
            peer.write("已落盘")
            tx_id, ack = peer.submit()

    connection = sqlite3.connect(database_path)
    try:
        row = connection.execute(
            "SELECT seq FROM updates WHERE document_id = ? AND tx_id = ?",
            (document_id, tx_id),
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    assert row[0] == ack["seq"]


def test_retry_with_same_tx_id_is_idempotent(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as socket:
            peer = Client(socket, document_id)
            peer.handshake()
            peer.write("重试")
            tx_id = str(uuid.uuid4())
            payload = peer.doc.get_update(peer.confirmed_state)

            socket.send_text(tx_frame(document_id, peer.sync_id, tx_id, payload))
            first = json.loads(socket.receive_text())
            socket.send_text(tx_frame(document_id, peer.sync_id, tx_id, payload))
            retry = json.loads(socket.receive_text())

    assert first["type"] == retry["type"] == "ack"
    assert first["seq"] == retry["seq"]
    assert sum(row.tx_id == tx_id for row in SqliteStore(database_path).load_updates(document_id)) == 1
    assert read_document_text(document_id, database_path) == "重试"


def test_same_tx_id_with_different_payload_is_rejected(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as socket:
            peer = Client(socket, document_id)
            peer.handshake()
            peer.write("第一版")
            tx_id, _ = peer.submit()

            peer.write("第二版")
            other_payload = peer.doc.get_update(peer.confirmed_state)
            socket.send_text(tx_frame(document_id, peer.sync_id, tx_id, other_payload))
            error = json.loads(socket.receive_text())

    assert error["type"] == "error"
    assert error["code"] == ErrorCode.TX_PAYLOAD_MISMATCH.value
    assert error["retryable"] is False


def test_invalid_update_is_rejected_and_room_stays_usable(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as socket:
            peer = Client(socket, document_id)
            peer.handshake()

            socket.send_text(tx_frame(document_id, peer.sync_id, str(uuid.uuid4()), b"\xff\xff"))
            error = json.loads(socket.receive_text())
            assert error["code"] == ErrorCode.INVALID_UPDATE.value
            assert error["retryable"] is False

        # 非可重试错误会关闭该连接；无效更新没有写入日志，房间仍然可用。
        with client.websocket_connect(ws_url(document_id)) as socket:
            peer = Client(socket, document_id)
            peer.handshake()
            peer.write("仍然可用")
            _, ack = peer.submit()
            assert ack["seq"] == 1
            assert peer.text() == "仍然可用"

    assert read_document_text(document_id, database_path) == "仍然可用"


def test_barrier_returns_ready_after_queued_work(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as socket:
            peer = Client(socket, document_id)
            peer.handshake()
            peer.write("屏障前")
            _, ack = peer.submit()

            barrier_id = str(uuid.uuid4())
            socket.send_text(sync_end_frame(document_id, peer.sync_id, barrier_id))
            ready = json.loads(socket.receive_text())

    assert ready["type"] == "ready"
    assert ready["barrierId"] == barrier_id
    assert ready["seq"] == ack["seq"]


def test_sync_delta_contains_what_the_client_lacks(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as first_socket:
            first = Client(first_socket, document_id)
            first.handshake()
            first.write("既有内容")
            first.submit()

            with client.websocket_connect(ws_url(document_id)) as second_socket:
                second = Client(second_socket, document_id)
                synced = second.handshake()
                assert synced["seq"] == 1
                assert second.text() == "既有内容"


def test_delete_only_update_propagates_across_connections(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as first_socket:
            with client.websocket_connect(ws_url(document_id)) as second_socket:
                first = Client(first_socket, document_id)
                second = Client(second_socket, document_id)
                first.handshake()
                second.handshake()

                first.write("abcdefghij")
                first.submit()
                second.apply(second.receive())
                assert second.text() == "abcdefghij"

                # 仅删除：状态向量不变，差量必须仍然包含删除信息。
                before = second.doc.get_state()
                second.erase(5, 2)
                assert second.doc.get_state() == before
                second.submit()
                first.apply(first.receive())

                assert first.text() == "abcdehij"
                assert read_document_text(document_id, database_path) == "abcdehij"


def test_documents_are_isolated(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        left_id = new_document_id(client)
        right_id = new_document_id(client)
        with client.websocket_connect(ws_url(left_id)) as left_socket:
            with client.websocket_connect(ws_url(right_id)) as right_socket:
                left = Client(left_socket, left_id)
                right = Client(right_socket, right_id)
                left.handshake()
                right.handshake()

                left.write("左文档")
                left.submit()
                right.write("右文档")
                right.submit()

    assert read_document_text(left_id, database_path) == "左文档"
    assert read_document_text(right_id, database_path) == "右文档"


# --- 故障语义 ---------------------------------------------------------------


def test_storage_failure_reports_retryable_error_without_ack(
    database_path: Path, monkeypatch: pytest.MonkeyPatch
):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as socket:
            peer = Client(socket, document_id)
            peer.handshake()
            peer.write("不会保存")

            def failing_append(*args: object, **kwargs: object):
                raise StorageUnavailable("模拟磁盘故障")

            monkeypatch.setattr(client.app.state.store, "append", failing_append)

            payload = peer.doc.get_update(peer.confirmed_state)
            socket.send_text(tx_frame(document_id, peer.sync_id, str(uuid.uuid4()), payload))
            error = json.loads(socket.receive_text())
            assert error["type"] == "error"
            assert error["code"] == ErrorCode.STORAGE_UNAVAILABLE.value
            assert error["retryable"] is True

            monkeypatch.undo()
            # 存储恢复后同一内容可以正常提交，此前的失败没有留下记录。
            _, ack = peer.submit()
            assert ack["seq"] == 1
            assert len(SqliteStore(database_path).load_updates(document_id)) == 2


class Gate:
    """跨线程门控：hook 在应用事件循环里等待，测试线程负责放行。

    ``block`` 限定只拦住某个 syncId 的发送，否则同一 hook 会把其他连接的
    writer 一起卡住，测不出“一条连接慢、其他连接照常”的行为。
    """

    def __init__(self) -> None:
        self.entered = threading.Event()
        self.released = threading.Event()
        self.blocked_sync_id: str | None = None

    def should_hold(self, sync_id: str) -> bool:
        return self.blocked_sync_id is not None and sync_id == self.blocked_sync_id


def test_handshake_has_no_subscription_gap(database_path: Path):
    """同步帧被推迟发送期间发生的提交，也必须到达该连接。"""
    gate = Gate()

    class GatedHooks(RoomHooks):
        async def before_sync_send(self, document_id: str, sync_id: str) -> None:
            if not gate.should_hold(sync_id):
                return
            gate.entered.set()
            await asyncio.to_thread(gate.released.wait, 60)

    try:
        with TestClient(create_app(database_path, hooks=GatedHooks())) as client:
            document_id = new_document_id(client)
            with client.websocket_connect(ws_url(document_id)) as slow_socket:
                slow = Client(slow_socket, document_id)
                gate.blocked_sync_id = slow.sync_id
                slow.send(hello_frame(document_id, slow.sync_id, slow.doc.get_state()))
                assert gate.entered.wait(10)

                # 同步响应尚未发出，此时另一连接完成提交。
                with client.websocket_connect(ws_url(document_id)) as fast_socket:
                    fast = Client(fast_socket, document_id)
                    fast.handshake()
                    fast.write("握手期间写入")
                    fast.submit()

                gate.released.set()

                # 慢连接最终会收到这次提交：先处理同步帧，再处理广播。
                synced = json.loads(slow_socket.receive_text())
                assert synced["type"] == "sync"
                slow.apply(synced)
                for _ in range(4):
                    if slow.text() == "握手期间写入":
                        break
                    slow.apply(slow.receive())
                assert slow.text() == "握手期间写入"
    finally:
        gate.released.set()


def test_slow_peer_is_closed_without_blocking_others(database_path: Path):
    """写队列溢出的连接被关闭，其他连接继续正常提交。"""
    gate = Gate()

    class GatedHooks(RoomHooks):
        async def before_sync_send(self, document_id: str, sync_id: str) -> None:
            if not gate.should_hold(sync_id):
                return
            gate.entered.set()
            await asyncio.to_thread(gate.released.wait, 60)

    try:
        with TestClient(create_app(database_path, hooks=GatedHooks())) as client:
            document_id = new_document_id(client)
            with client.websocket_connect(ws_url(document_id)) as slow_socket:
                slow = Client(slow_socket, document_id)
                gate.blocked_sync_id = slow.sync_id
                slow.send(hello_frame(document_id, slow.sync_id, slow.doc.get_state()))
                assert gate.entered.wait(10)

                # 慢连接的 writer 停在 hook 里，其发送队列不会被消费。
                with client.websocket_connect(ws_url(document_id)) as fast_socket:
                    fast = Client(fast_socket, document_id)
                    fast.handshake()
                    for index in range(MAX_OUTGOING_FRAMES + 8):
                        fast.write(str(index % 10))
                        _, ack = fast.submit()
                    # 房间没有被慢连接拖住：最后一个确认仍然推进了服务端序号。
                    assert ack["seq"] == MAX_OUTGOING_FRAMES + 8

                with pytest.raises(Exception):  # noqa: BLE001 - 连接被服务端关闭正是被测行为
                    slow_socket.receive_text()
    finally:
        gate.released.set()


def test_leaving_releases_subscription(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as first_socket:
            peer = Client(first_socket, document_id)
            peer.handshake()
            first_socket.close()

        with client.websocket_connect(ws_url(document_id)) as second_socket:
            second = Client(second_socket, document_id)
            second.handshake()
            room = client.app.state.rooms._rooms[document_id]
            assert list(room.peers) == [second.sync_id]
            second.write("仍然工作")
            second.submit()


def test_sequential_commits_keep_memory_and_log_in_step(database_path: Path):
    """连续提交后，内存房间与日志重放必须得到相同正文。"""
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as socket:
            peer = Client(socket, document_id)
            peer.handshake()
            for index in range(3):
                peer.write(str(index))
                peer.submit()

            room = client.app.state.rooms._rooms[document_id]
            in_memory = room.doc.get("body", type=XmlFragment).children[0]
            in_memory_text = "".join(str(child) for child in in_memory.children)
            assert in_memory_text == read_document_text(document_id, database_path) == "012"


def test_restart_recovers_documents_from_log(database_path: Path):
    """服务端重启：已确认的修改保留，新旧客户端都能恢复同步。"""
    with TestClient(create_app(database_path)) as client:
        document_id = new_document_id(client)
        with client.websocket_connect(ws_url(document_id)) as socket:
            peer = Client(socket, document_id)
            peer.handshake()
            peer.write("重启前")
            peer.submit()
        old_state_vector = peer.doc.get_state()

    with TestClient(create_app(database_path)) as client:
        with client.websocket_connect(ws_url(document_id)) as socket:
            fresh = Client(socket, document_id)
            fresh.handshake()
            assert fresh.text() == "重启前"

        # 旧客户端带着自己的状态向量重连，只取自己缺失的部分。
        with client.websocket_connect(ws_url(document_id)) as socket:
            returning = Client(socket, document_id)
            returning.doc.apply_update(peer.doc.get_update())
            returning.confirmed_state = returning.doc.get_state()
            synced = returning.handshake()
            assert synced["seq"] == 1
            assert returning.text() == "重启前"
            assert old_state_vector == returning.confirmed_state
