"""仅测试进程装载的故障门控服务。

正常入口 ``app.main`` 不挂载任何控制路由。这里复用同一个 ``create_app``，额外
注入可控 hooks 并暴露一组只监听回环地址、需要令牌的控制接口，用来在真实的
提交与发送路径上制造可复现的故障窗口。

启动方式（由 Playwright fixture 调用）::

    python -m tests.e2e_server

环境变量：``COLLAB_DB_PATH``、``COLLAB_PORT``、``COLLAB_CONTROL_TOKEN``。
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path

# 支持 `python -m tests.e2e_server`：把 backend 目录放入模块搜索路径。
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI, Header, HTTPException, Request  # noqa: E402
from pydantic import BaseModel, ConfigDict  # noqa: E402

from app.main import create_app  # noqa: E402
from app.room import RoomHooks  # noqa: E402

#: 等待门控被触发的最长时间；超时说明测试假设不成立，应尽快失败而不是挂住。
GATE_ENTER_TIMEOUT_SECONDS = 10
#: 门控最多拦住请求多久，避免测试异常退出后服务端永久卡死。
GATE_HOLD_TIMEOUT_SECONDS = 30

GatePoint = str


class Gate:
    """一次性的故障窗口：进入时置位 entered，直到被显式放行。"""

    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.released = asyncio.Event()

    async def hold(self) -> None:
        self.entered.set()
        try:
            await asyncio.wait_for(self.released.wait(), timeout=GATE_HOLD_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            # 超时后自动放行，避免测试失败留下永久阻塞的服务进程。
            return

    def release(self) -> None:
        self.released.set()


@dataclass
class ArmedGate:
    gate_id: str
    point: GatePoint
    document_id: str | None
    tx_id: str | None
    sync_id: str | None
    gate: Gate
    fired: bool = False


class GateRegistry:
    def __init__(self) -> None:
        self._gates: dict[str, ArmedGate] = {}
        self._lock = asyncio.Lock()

    async def arm(
        self,
        point: GatePoint,
        document_id: str | None = None,
        tx_id: str | None = None,
        sync_id: str | None = None,
    ) -> str:
        gate_id = str(uuid.uuid4())
        async with self._lock:
            self._gates[gate_id] = ArmedGate(
                gate_id=gate_id,
                point=point,
                document_id=document_id,
                tx_id=tx_id,
                sync_id=sync_id,
                gate=Gate(),
            )
        return gate_id

    async def get(self, gate_id: str) -> ArmedGate:
        async with self._lock:
            armed = self._gates.get(gate_id)
        if armed is None:
            raise KeyError(gate_id)
        return armed

    async def armed_gates(self) -> list[ArmedGate]:
        async with self._lock:
            return list(self._gates.values())

    async def hold_matching(
        self,
        point: GatePoint,
        *,
        document_id: str,
        tx_id: str | None = None,
        sync_id: str | None = None,
    ) -> None:
        """在真实路径上按匹配条件触发一次门控。每个门只生效一次。"""
        async with self._lock:
            matched = [
                armed
                for armed in self._gates.values()
                if not armed.fired
                and armed.point == point
                and (armed.document_id is None or armed.document_id == document_id)
                and (armed.tx_id is None or armed.tx_id == tx_id)
                and (armed.sync_id is None or armed.sync_id == sync_id)
            ]
            for armed in matched:
                armed.fired = True
        # 并发挂起所有命中的门：串行等待会让第二个门永远进不去。
        if matched:
            await asyncio.gather(*(armed.gate.hold() for armed in matched))

    async def release_all(self) -> None:
        async with self._lock:
            gates = list(self._gates.values())
        for armed in gates:
            armed.gate.release()


class ControlledHooks(RoomHooks):
    """把真实的提交与发送路径接到门控注册表上。"""

    def __init__(self, gates: GateRegistry) -> None:
        self.gates = gates

    async def after_commit(self, document_id: str, tx_id: str, seq: int) -> None:
        # 位于房间锁内、数据库提交之后：暂停这里就等于制造“已落盘但还没广播”的窗口。
        await self.gates.hold_matching('after_commit', document_id=document_id, tx_id=tx_id)

    async def before_sync_send(self, document_id: str, sync_id: str) -> None:
        # 位于连接 writer 内，不持有房间锁，因此不影响其他连接继续提交。
        await self.gates.hold_matching('before_sync_send', document_id=document_id, sync_id=sync_id)

    async def before_ack_send(self, document_id: str, tx_id: str) -> None:
        await self.gates.hold_matching('before_ack_send', document_id=document_id, tx_id=tx_id)


class ArmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    point: str
    documentId: str | None = None
    txId: str | None = None
    syncId: str | None = None


def build_app(database_path: Path, control_token: str) -> FastAPI:
    gates = GateRegistry()
    app = create_app(database_path, hooks=ControlledHooks(gates))

    def authorize(token: str | None) -> None:
        if token != control_token:
            raise HTTPException(status_code=403, detail="控制接口令牌不正确")

    @app.post("/control/gates")
    async def arm_gate(payload: ArmRequest, request: Request, x_control_token: str | None = Header(default=None)) -> dict[str, str]:
        authorize(x_control_token)
        gate_id = await gates.arm(
            payload.point,
            document_id=payload.documentId,
            tx_id=payload.txId,
            sync_id=payload.syncId,
        )
        return {"gateId": gate_id}

    @app.post("/control/gates/{gate_id}/wait")
    async def wait_gate(gate_id: str, x_control_token: str | None = Header(default=None)) -> dict[str, bool]:
        authorize(x_control_token)
        try:
            armed = await gates.get(gate_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="未知门控") from error
        try:
            await asyncio.wait_for(armed.gate.entered.wait(), timeout=GATE_ENTER_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as error:
            raise HTTPException(status_code=504, detail="门控未被触发") from error
        return {"entered": True}

    @app.post("/control/gates/{gate_id}/release")
    async def release_gate(gate_id: str, x_control_token: str | None = Header(default=None)) -> dict[str, bool]:
        authorize(x_control_token)
        try:
            armed = await gates.get(gate_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="未知门控") from error
        armed.gate.release()
        return {"released": True}

    @app.post("/control/gates/release-all")
    async def release_all(x_control_token: str | None = Header(default=None)) -> dict[str, bool]:
        authorize(x_control_token)
        await gates.release_all()
        return {"released": True}

    return app


def main() -> None:
    import uvicorn

    database_path = Path(os.environ["COLLAB_DB_PATH"])
    port = int(os.environ.get("COLLAB_PORT", "8791"))
    control_token = os.environ.get("COLLAB_CONTROL_TOKEN", "")

    # 只监听回环地址：控制接口不应出现在任何可被外部访问的接口上。
    uvicorn.run(build_app(database_path, control_token), host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
