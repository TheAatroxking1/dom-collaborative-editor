"""协议解析的输入校验与边界。"""

from __future__ import annotations

import base64
import json
import uuid

import pytest

from app.protocol import (
    MAX_FRAME_BYTES,
    MAX_UPDATE_BYTES,
    PROTOCOL_VERSION,
    ErrorCode,
    Hello,
    ProtocolError,
    SyncEnd,
    Transaction,
    encode_ack,
    encode_error,
    encode_ready,
    encode_sync,
    parse_client_message,
)

DOCUMENT_ID = str(uuid.uuid4())
SYNC_ID = str(uuid.uuid4())
TX_ID = str(uuid.uuid4())
BARRIER_ID = str(uuid.uuid4())

BODY = b"\x00\x01\x02payload"


def hello_frame(**overrides: object) -> str:
    frame = {
        "v": PROTOCOL_VERSION,
        "type": "hello",
        "documentId": DOCUMENT_ID,
        "syncId": SYNC_ID,
        "stateVector": base64.b64encode(BODY).decode("ascii"),
    }
    frame.update(overrides)
    return json.dumps(frame)


def tx_frame(**overrides: object) -> str:
    frame = {
        "v": PROTOCOL_VERSION,
        "type": "tx",
        "documentId": DOCUMENT_ID,
        "syncId": SYNC_ID,
        "txId": TX_ID,
        "kind": "edit",
        "update": base64.b64encode(BODY).decode("ascii"),
    }
    frame.update(overrides)
    return json.dumps(frame)


def expect_error(raw: str, code: ErrorCode) -> ProtocolError:
    with pytest.raises(ProtocolError) as info:
        parse_client_message(raw)
    assert info.value.code is code
    return info.value


def test_hello_round_trips_to_typed_frame():
    frame = parse_client_message(hello_frame())
    assert isinstance(frame, Hello)
    assert frame.document_id == DOCUMENT_ID
    assert frame.sync_id == SYNC_ID
    assert frame.state_vector == BODY


def test_tx_round_trips_to_typed_frame():
    frame = parse_client_message(tx_frame())
    assert isinstance(frame, Transaction)
    assert frame.tx_id == TX_ID
    assert frame.kind == "edit"
    assert frame.update == BODY

    catchup = parse_client_message(tx_frame(kind="catchup"))
    assert isinstance(catchup, Transaction)
    assert catchup.kind == "catchup"


def test_sync_end_round_trips_to_typed_frame():
    raw = json.dumps(
        {
            "v": PROTOCOL_VERSION,
            "type": "sync-end",
            "documentId": DOCUMENT_ID,
            "syncId": SYNC_ID,
            "barrierId": BARRIER_ID,
        }
    )
    frame = parse_client_message(raw)
    assert isinstance(frame, SyncEnd)
    assert frame.barrier_id == BARRIER_ID


def test_unsupported_version_is_not_retryable():
    error = expect_error(hello_frame(v=PROTOCOL_VERSION + 1), ErrorCode.UNSUPPORTED_VERSION)
    assert not error.retryable


def test_boolean_version_is_rejected_as_bad_message():
    expect_error(hello_frame(v=True), ErrorCode.BAD_MESSAGE)


def test_non_numeric_version_is_rejected():
    expect_error(hello_frame(v="1"), ErrorCode.BAD_MESSAGE)


@pytest.mark.parametrize("document_id", ["not-a-uuid", "", "12345"])
def test_malformed_document_id_is_rejected(document_id: str):
    expect_error(hello_frame(documentId=document_id), ErrorCode.BAD_MESSAGE)


def test_malformed_sync_id_is_rejected():
    expect_error(hello_frame(syncId="nope"), ErrorCode.BAD_MESSAGE)


def test_unknown_field_is_rejected():
    expect_error(hello_frame(extra="x"), ErrorCode.BAD_MESSAGE)


def test_missing_field_is_rejected():
    raw = json.dumps({"v": PROTOCOL_VERSION, "type": "hello", "documentId": DOCUMENT_ID})
    expect_error(raw, ErrorCode.BAD_MESSAGE)


def test_unknown_type_is_rejected():
    expect_error(hello_frame(type="nonsense"), ErrorCode.BAD_MESSAGE)


@pytest.mark.parametrize("value", ["not base64!!", "====", "中文"])
def test_invalid_base64_is_rejected(value: str):
    expect_error(hello_frame(stateVector=value), ErrorCode.BAD_MESSAGE)
    expect_error(tx_frame(update=value), ErrorCode.BAD_MESSAGE)


def test_invalid_base64_padding_is_rejected():
    # validate=True 会拒绝非字母表字符与被截断的填充。
    expect_error(hello_frame(stateVector="QQ"), ErrorCode.BAD_MESSAGE)


def test_non_json_frame_is_rejected():
    expect_error("{not json", ErrorCode.BAD_MESSAGE)


def test_non_object_frame_is_rejected():
    expect_error("[1, 2, 3]", ErrorCode.BAD_MESSAGE)


def test_oversized_update_is_rejected_before_use():
    oversized = base64.b64encode(b"\x00" * (MAX_UPDATE_BYTES + 1)).decode("ascii")
    error = expect_error(tx_frame(update=oversized), ErrorCode.UPDATE_TOO_LARGE)
    assert not error.retryable


def test_oversized_frame_is_rejected():
    expect_error("x" * (MAX_FRAME_BYTES + 1), ErrorCode.BAD_MESSAGE)


def test_unknown_tx_kind_is_rejected():
    expect_error(tx_frame(kind="replay"), ErrorCode.BAD_MESSAGE)


def test_only_storage_and_room_errors_are_retryable():
    retryable = {
        code for code in ErrorCode if ProtocolError(code, "x").retryable
    }
    assert retryable == {ErrorCode.STORAGE_UNAVAILABLE, ErrorCode.ROOM_UNAVAILABLE}


def test_encoded_server_messages_carry_envelope_and_payload():
    sync = json.loads(encode_sync(DOCUMENT_ID, SYNC_ID, BODY, b"\x09", 7))
    assert sync["type"] == "sync"
    assert sync["v"] == PROTOCOL_VERSION
    assert sync["documentId"] == DOCUMENT_ID
    assert sync["syncId"] == SYNC_ID
    assert base64.b64decode(sync["update"]) == BODY
    assert base64.b64decode(sync["stateVector"]) == b"\x09"
    assert sync["seq"] == 7

    ack = json.loads(encode_ack(DOCUMENT_ID, SYNC_ID, TX_ID, 3))
    assert ack["type"] == "ack"
    assert ack["txId"] == TX_ID
    assert ack["seq"] == 3

    ready = json.loads(encode_ready(DOCUMENT_ID, SYNC_ID, BARRIER_ID, 3))
    assert ready["type"] == "ready"
    assert ready["barrierId"] == BARRIER_ID

    error = json.loads(encode_error(DOCUMENT_ID, SYNC_ID, ErrorCode.STORAGE_UNAVAILABLE, "忙"))
    assert error["type"] == "error"
    assert error["code"] == "STORAGE_UNAVAILABLE"
    assert error["retryable"] is True
    assert error["message"] == "忙"


def test_encoded_error_defaults_retryable_from_code():
    assert json.loads(encode_error(DOCUMENT_ID, SYNC_ID, ErrorCode.BAD_MESSAGE, "坏"))[
        "retryable"
    ] is False
    assert json.loads(encode_error(DOCUMENT_ID, SYNC_ID, ErrorCode.ROOM_UNAVAILABLE, "忙"))[
        "retryable"
    ] is True
