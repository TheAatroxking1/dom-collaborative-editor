"""WebSocket 协议：消息编解码、大小限制与错误码。

线上格式固定为 JSON 信封加 Base64 二进制字段，便于调试；代价是额外体积。
本模块是唯一做格式校验的地方：房间与传输层只接收这里解析出的类型化对象，
因此无效消息不会带着半解析状态流入 CRDT 或数据库。

Pydantic 模型直接使用线上字段名（camelCase），避免别名映射带来的偏差。
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from enum import Enum
from typing import Annotated, Literal, Union
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictInt, TypeAdapter, ValidationError

PROTOCOL_VERSION = 1

#: 单个 CRDT 更新的上限。候选完整状态也受此约束，保证它仍能通过重连通道传输。
MAX_UPDATE_BYTES = 1024 * 1024
#: 单个 WebSocket 文本帧的上限。
MAX_FRAME_BYTES = 2 * 1024 * 1024
#: 客户端待发送更新的累计上限（前端使用）。
MAX_PENDING_BYTES = 8 * 1024 * 1024
#: 单个连接发送队列的帧数上限，超过则关闭该慢连接并由重连补同步。
MAX_OUTGOING_FRAMES = 256

#: 无法从帧中取得有效 syncId 时使用的占位符。
NIL_SYNC_ID = "00000000-0000-0000-0000-000000000000"


class ErrorCode(str, Enum):
    BAD_MESSAGE = "BAD_MESSAGE"
    UNSUPPORTED_VERSION = "UNSUPPORTED_VERSION"
    DOCUMENT_NOT_FOUND = "DOCUMENT_NOT_FOUND"
    TX_PAYLOAD_MISMATCH = "TX_PAYLOAD_MISMATCH"
    UPDATE_TOO_LARGE = "UPDATE_TOO_LARGE"
    INVALID_UPDATE = "INVALID_UPDATE"
    STORAGE_UNAVAILABLE = "STORAGE_UNAVAILABLE"
    ROOM_UNAVAILABLE = "ROOM_UNAVAILABLE"


#: 只有存储与房间故障可以自动重试；其余都是协议或数据错误，盲目重发没有意义。
RETRYABLE_CODES = frozenset({ErrorCode.STORAGE_UNAVAILABLE, ErrorCode.ROOM_UNAVAILABLE})


class ProtocolError(Exception):
    """携带固定错误码的协议异常。"""

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(f"{code.value}: {message}")
        self.code = code
        self.message = message

    @property
    def retryable(self) -> bool:
        return self.code in RETRYABLE_CODES


# --- 线上消息模型 -----------------------------------------------------------


class _WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _Envelope(_WireModel):
    v: StrictInt
    documentId: UUID
    syncId: UUID


class _HelloWire(_Envelope):
    type: Literal["hello"]
    stateVector: str


class _TxWire(_Envelope):
    type: Literal["tx"]
    txId: UUID
    kind: Literal["edit", "catchup"]
    update: str


class _SyncEndWire(_Envelope):
    type: Literal["sync-end"]
    barrierId: UUID


_ClientWire = Annotated[
    Union[_HelloWire, _TxWire, _SyncEndWire],
    Field(discriminator="type"),
]
_CLIENT_ADAPTER: TypeAdapter[_ClientWire] = TypeAdapter(_ClientWire)


# --- 解析结果 ---------------------------------------------------------------


@dataclass(frozen=True)
class Hello:
    document_id: str
    sync_id: str
    state_vector: bytes


@dataclass(frozen=True)
class Transaction:
    document_id: str
    sync_id: str
    tx_id: str
    kind: Literal["edit", "catchup"]
    update: bytes


@dataclass(frozen=True)
class SyncEnd:
    document_id: str
    sync_id: str
    barrier_id: str


ClientFrame = Union[Hello, Transaction, SyncEnd]


def _decode_base64(value: str, field: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ProtocolError(ErrorCode.BAD_MESSAGE, f"{field} 不是有效的 Base64") from error


def parse_client_message(raw: str) -> ClientFrame:
    """把原始文本帧解析为类型化消息，任何偏差都以固定错误码拒绝。"""
    if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
        raise ProtocolError(ErrorCode.BAD_MESSAGE, "帧超过大小上限")

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ProtocolError(ErrorCode.BAD_MESSAGE, "帧不是有效 JSON") from error
    if not isinstance(payload, dict):
        raise ProtocolError(ErrorCode.BAD_MESSAGE, "帧顶层必须是对象")

    version = payload.get("v")
    if isinstance(version, int) and not isinstance(version, bool) and version != PROTOCOL_VERSION:
        raise ProtocolError(
            ErrorCode.UNSUPPORTED_VERSION, f"不支持的协议版本 {version}"
        )

    try:
        message = _CLIENT_ADAPTER.validate_python(payload)
    except ValidationError as error:
        raise ProtocolError(ErrorCode.BAD_MESSAGE, "帧字段不合法") from error

    document_id = str(message.documentId)
    sync_id = str(message.syncId)

    if isinstance(message, _HelloWire):
        return Hello(
            document_id=document_id,
            sync_id=sync_id,
            state_vector=_decode_base64(message.stateVector, "stateVector"),
        )
    if isinstance(message, _TxWire):
        update = _decode_base64(message.update, "update")
        if len(update) > MAX_UPDATE_BYTES:
            raise ProtocolError(ErrorCode.UPDATE_TOO_LARGE, "更新超过大小上限")
        return Transaction(
            document_id=document_id,
            sync_id=sync_id,
            tx_id=str(message.txId),
            kind=message.kind,
            update=update,
        )
    return SyncEnd(
        document_id=document_id, sync_id=sync_id, barrier_id=str(message.barrierId)
    )


def _dump(**fields: object) -> str:
    return json.dumps(fields, ensure_ascii=False, separators=(",", ":"))


def encode_sync(
    document_id: str, sync_id: str, update: bytes, state_vector: bytes, seq: int
) -> str:
    return _dump(
        v=PROTOCOL_VERSION,
        type="sync",
        documentId=document_id,
        syncId=sync_id,
        update=base64.b64encode(update).decode("ascii"),
        stateVector=base64.b64encode(state_vector).decode("ascii"),
        seq=seq,
    )


def encode_update(document_id: str, sync_id: str, update: bytes, seq: int) -> str:
    return _dump(
        v=PROTOCOL_VERSION,
        type="update",
        documentId=document_id,
        syncId=sync_id,
        update=base64.b64encode(update).decode("ascii"),
        seq=seq,
    )


def encode_ack(document_id: str, sync_id: str, tx_id: str, seq: int) -> str:
    return _dump(
        v=PROTOCOL_VERSION,
        type="ack",
        documentId=document_id,
        syncId=sync_id,
        txId=tx_id,
        seq=seq,
    )


def encode_ready(document_id: str, sync_id: str, barrier_id: str, seq: int) -> str:
    return _dump(
        v=PROTOCOL_VERSION,
        type="ready",
        documentId=document_id,
        syncId=sync_id,
        barrierId=barrier_id,
        seq=seq,
    )


def encode_error(
    document_id: str,
    sync_id: str,
    code: ErrorCode,
    message: str,
    retryable: bool | None = None,
) -> str:
    if retryable is None:
        retryable = code in RETRYABLE_CODES
    return _dump(
        v=PROTOCOL_VERSION,
        type="error",
        documentId=document_id,
        syncId=sync_id,
        code=code.value,
        retryable=retryable,
        message=message,
    )
