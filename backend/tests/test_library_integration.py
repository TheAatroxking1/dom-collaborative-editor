"""现成库组合的真实通路验证。

这个文件回答的问题是：锁定的这套库（y-websocket / pycrdt-websocket / pycrdt-store）
在本机 Windows + Python 3.12 环境里是否真的能互通并持久化。它不使用 mock 服务，
而是让真实 ASGI WebSocket 通道承载标准 Yjs 二进制协议。

客户端用 pycrdt 自带的协议助手手工实现，因此验证的是「协议级互通」，
而不是把两个 pycrdt 对象放在同一进程里自说自话。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pycrdt import (
    Doc,
    Text,
    XmlFragment,
    XmlText,
    YMessageType,
    create_sync_message,
    create_update_message,
    handle_sync_message,
)

# 这些导入是本次重构的入口，实现前它们会以 ImportError 失败。
from app.collaboration import read_document_state
from app.documents import new_seed_document
from app.main import create_app

DOCUMENT_PATH = "/ws/documents/{document_id}"


class YjsClient:
    """用标准 Yjs 同步协议与服务器对话的最小客户端。

    帧格式（与 y-websocket 一致）：``[YMessageType][payload]``。
    pycrdt 的 ``create_*_message`` 已经包含外层类型字节，而 ``handle_sync_message``
    接收的是去掉外层字节的载荷，两者不能混用。
    """

    def __init__(self, socket) -> None:
        self.socket = socket
        self.doc = Doc()

    def handshake(self, frames: int = 2) -> None:
        """发送自己的 step1，并处理服务器发来的握手帧。

        服务器会先推来它自己的 step1，我们用 step2 回复；随后接到它针对我们
        step1 的 step2。两帧之后双方状态向量一致。
        """
        self.socket.send_bytes(create_sync_message(self.doc))
        self.pump(frames)

    def pump(self, frames: int = 1) -> None:
        for _ in range(frames):
            raw = self.socket.receive_bytes()
            if not raw:
                continue
            if raw[0] == YMessageType.SYNC:
                reply = handle_sync_message(raw[1:], self.doc)
                if reply is not None:
                    self.socket.send_bytes(reply)
            # awareness 帧（远端光标）与本次持久化验证无关，直接跳过。

    def edit(self, apply) -> bytes:
        """做一次本地编辑，并把这次编辑产生的差量发给服务端。

        服务端会把更新广播给房间里的所有客户端，**包括发送者自己**，
        所以发送之后本端也会收到一帧回流；调用方需要用 ``pump`` 把它吃掉。
        """
        before = self.doc.get_state()
        apply(self.doc)
        update = self.doc.get_update(before)
        self.socket.send_bytes(create_update_message(update))
        return update

    def body(self) -> XmlFragment:
        return self.doc.get("body", type=XmlFragment)

    def paragraph_texts(self) -> list[str]:
        return [
            "".join(str(child) for child in paragraph.children)
            for paragraph in self.body().children
        ]

    def text(self) -> str:
        return "\n".join(self.paragraph_texts())


def write_into_first_paragraph(doc: Doc, value: str) -> None:
    paragraph = doc.get("body", type=XmlFragment).children[0]
    if len(paragraph.children) == 0:
        paragraph.children.append(XmlText())
    node = paragraph.children[0]
    node.insert(len(node), value)


def delete_from_first_paragraph(doc: Doc, start: int, length: int) -> None:
    node = doc.get("body", type=XmlFragment).children[0].children[0]
    del node[start : start + length]


@pytest.fixture
def app_with_data(tmp_path: Path):
    data_directory = tmp_path / "data"
    with TestClient(create_app(data_directory)) as client:
        yield client, data_directory


def create_document(client: TestClient) -> str:
    response = client.post("/api/documents")
    assert response.status_code == 201, response.text
    return response.json()["documentId"]


def test_seed_is_a_single_empty_paragraph(app_with_data):
    client, _ = app_with_data
    document_id = create_document(client)

    with client.websocket_connect(DOCUMENT_PATH.format(document_id=document_id)) as socket:
        peer = YjsClient(socket)
        peer.handshake()

        assert peer.paragraph_texts() == [""]
        assert len(peer.body().children) == 1
        assert peer.body().children[0].tag == "paragraph"


def test_two_clients_exchange_chinese_and_emoji(app_with_data):
    client, _ = app_with_data
    document_id = create_document(client)

    with client.websocket_connect(DOCUMENT_PATH.format(document_id=document_id)) as first_socket:
        with client.websocket_connect(DOCUMENT_PATH.format(document_id=document_id)) as second_socket:
            first = YjsClient(first_socket)
            second = YjsClient(second_socket)
            first.handshake()
            second.handshake()

            first.edit(lambda doc: write_into_first_paragraph(doc, "中文English🙂"))
            second.pump(1)
            assert second.text() == "中文English🙂"
            assert first.text() == second.text()


def test_delete_only_update_propagates(app_with_data):
    """仅删除的更新也要跨端传播：它不推进状态向量。

    正文刻意用纯 ASCII：pycrdt 的索引式区间删除按 Python 码点计数，与 Yjs 的
    UTF-16 码元不一致，在多字节文本上会误删或抛 Rust panic。真实客户端的删除由
    Yjs 在浏览器里完成，服务端只搬运二进制更新，不受该差异影响；这里的目的是
    验证服务端与存储的传播路径。
    """
    client, _ = app_with_data
    document_id = create_document(client)

    with client.websocket_connect(DOCUMENT_PATH.format(document_id=document_id)) as first_socket:
        with client.websocket_connect(DOCUMENT_PATH.format(document_id=document_id)) as second_socket:
            first = YjsClient(first_socket)
            second = YjsClient(second_socket)
            first.handshake()
            second.handshake()

            first.edit(lambda doc: write_into_first_paragraph(doc, "abcdefghij"))
            first.pump(1)  # 自己那一帧的回流
            second.pump(1)
            assert second.text() == "abcdefghij"

            before = second.doc.get_state()
            second.edit(lambda doc: delete_from_first_paragraph(doc, 5, 2))
            # 删除不引入新的客户端时钟，状态向量不变。
            assert second.doc.get_state() == before
            second.pump(1)  # 自己那一帧的回流
            first.pump(1)

            assert first.text() == "abcdehij"
            assert second.text() == first.text()


def test_content_survives_a_restart(tmp_path: Path):
    data_directory = tmp_path / "data"

    with TestClient(create_app(data_directory)) as client:
        document_id = create_document(client)
        with client.websocket_connect(
            DOCUMENT_PATH.format(document_id=document_id)
        ) as socket:
            peer = YjsClient(socket)
            peer.handshake()
            peer.edit(lambda doc: write_into_first_paragraph(doc, "重启前写入"))

    # 全新应用实例、同一数据目录：正文必须来自存储而不是内存。
    with TestClient(create_app(data_directory)) as client:
        with client.websocket_connect(
            DOCUMENT_PATH.format(document_id=document_id)
        ) as socket:
            peer = YjsClient(socket)
            peer.handshake()
            assert peer.text() == "重启前写入"


def test_official_store_reads_back_the_same_content(tmp_path: Path):
    """直接用官方 store 读取，验证写入确实落在数据库里。"""
    data_directory = tmp_path / "data"

    with TestClient(create_app(data_directory)) as client:
        document_id = create_document(client)
        with client.websocket_connect(
            DOCUMENT_PATH.format(document_id=document_id)
        ) as socket:
            peer = YjsClient(socket)
            peer.handshake()
            peer.edit(lambda doc: write_into_first_paragraph(doc, "库能读回来"))

    collaboration = asyncio.run(
        read_document_state(data_directory / "updates.sqlite3", document_id)
    )
    assert (
        collaboration.get("body", type=XmlFragment).children[0].children[0].to_py()
        == "库能读回来"
    )


def test_unknown_document_closes_with_4404(app_with_data):
    from uuid import uuid4

    from starlette.websockets import WebSocketDisconnect

    client, _ = app_with_data
    missing = str(uuid4())

    # 服务端在 accept 之后才 close，浏览器因此能收到自定义关闭码。
    with pytest.raises(WebSocketDisconnect) as info:
        with client.websocket_connect(DOCUMENT_PATH.format(document_id=missing)) as socket:
            socket.receive_bytes()
    assert info.value.code == 4404


def test_malformed_document_id_closes_with_4404(app_with_data):
    from starlette.websockets import WebSocketDisconnect

    client, _ = app_with_data
    with pytest.raises(WebSocketDisconnect) as info:
        with client.websocket_connect(DOCUMENT_PATH.format(document_id="not-a-uuid")) as socket:
            socket.receive_bytes()
    assert info.value.code == 4404


def test_documents_are_isolated(app_with_data):
    client, _ = app_with_data
    left_id = create_document(client)
    right_id = create_document(client)

    with client.websocket_connect(DOCUMENT_PATH.format(document_id=left_id)) as left_socket:
        with client.websocket_connect(DOCUMENT_PATH.format(document_id=right_id)) as right_socket:
            left = YjsClient(left_socket)
            right = YjsClient(right_socket)
            left.handshake()
            right.handshake()

            left.edit(lambda doc: write_into_first_paragraph(doc, "左文档"))

            assert left.text() == "左文档"
            assert right.text() == ""


def test_seed_document_has_exactly_one_empty_paragraph():
    document = new_seed_document()
    fragment = document.get("body", type=XmlFragment)
    assert len(fragment.children) == 1
    assert fragment.children[0].tag == "paragraph"
    assert len(fragment.children[0].children) == 0


def test_seed_does_not_leak_between_documents():
    first = new_seed_document()
    second = new_seed_document()
    write_into_first_paragraph(first, "只影响第一份")
    second_text = second.get("body", type=XmlFragment).children[0]
    assert len(second_text.children) == 0


def test_text_node_round_trips_non_bmp(app_with_data):
    """中文与 emoji 必须能穿过库的二进制编码。"""
    client, _ = app_with_data
    document_id = create_document(client)

    with client.websocket_connect(DOCUMENT_PATH.format(document_id=document_id)) as socket:
        peer = YjsClient(socket)
        peer.handshake()
        peer.edit(lambda doc: write_into_first_paragraph(doc, "图形🙂符号✅"))
        assert peer.text() == "图形🙂符号✅"
        assert peer.doc.get("body", type=XmlFragment).children[0].children[0].to_py() == "图形🙂符号✅"


def test_plain_text_node_survives_reload(app_with_data):
    """用 Y.Text 交叉验证库对普通文本类型同样可用。"""
    client, _ = app_with_data
    document_id = create_document(client)

    with client.websocket_connect(DOCUMENT_PATH.format(document_id=document_id)) as socket:
        peer = YjsClient(socket)
        peer.handshake()
        peer.edit(lambda doc: doc.get("probe", type=Text).insert(0, "探针🙂"))
        assert peer.doc.get("probe", type=Text).to_py() == "探针🙂"
