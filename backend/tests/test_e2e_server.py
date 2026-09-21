"""测试用故障门控服务：控制接口鉴权、门控匹配与钩子接线。

门控服务是整个端到端故障验收的地基，它自身的匹配与释放语义必须先在单元层面
被固定住，否则外层的崩溃与丢包测试失败时无法判断是产品缺陷还是夹具缺陷。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.e2e_server import ControlledHooks, GateRegistry, build_app

TOKEN = "test-control-token"


def run(coroutine):
    return asyncio.run(coroutine)


# --- 门控匹配语义 -----------------------------------------------------------


def test_gate_holds_matching_call_until_released():
    async def scenario() -> None:
        registry = GateRegistry()
        gate_id = await registry.arm("after_commit", document_id="doc-1")
        holding = asyncio.create_task(
            registry.hold_matching("after_commit", document_id="doc-1", tx_id="tx-1")
        )
        armed = await registry.get(gate_id)
        await asyncio.wait_for(armed.gate.entered.wait(), timeout=1)
        assert not holding.done()

        armed.gate.release()
        await asyncio.wait_for(holding, timeout=1)

    run(scenario())


def test_gate_ignores_other_documents_and_points():
    async def scenario() -> None:
        registry = GateRegistry()
        await registry.arm("after_commit", document_id="doc-1")

        # 文档不匹配与挂点不匹配都不应触发门控。
        await asyncio.wait_for(
            registry.hold_matching("after_commit", document_id="doc-2", tx_id="tx"), timeout=1
        )
        await asyncio.wait_for(
            registry.hold_matching("before_ack_send", document_id="doc-1", tx_id="tx"), timeout=1
        )

    run(scenario())


def test_gate_matches_on_transaction_id():
    async def scenario() -> None:
        registry = GateRegistry()
        gate_id = await registry.arm("before_ack_send", document_id="doc-1", tx_id="tx-wanted")

        await asyncio.wait_for(
            registry.hold_matching("before_ack_send", document_id="doc-1", tx_id="tx-other"),
            timeout=1,
        )

        holding = asyncio.create_task(
            registry.hold_matching("before_ack_send", document_id="doc-1", tx_id="tx-wanted")
        )
        armed = await registry.get(gate_id)
        await asyncio.wait_for(armed.gate.entered.wait(), timeout=1)
        assert not holding.done()
        armed.gate.release()
        await asyncio.wait_for(holding, timeout=1)

    run(scenario())


def test_gate_fires_only_once():
    async def scenario() -> None:
        registry = GateRegistry()
        gate_id = await registry.arm("after_commit", document_id="doc-1")

        first = asyncio.create_task(
            registry.hold_matching("after_commit", document_id="doc-1", tx_id="tx-1")
        )
        armed = await registry.get(gate_id)
        await asyncio.wait_for(armed.gate.entered.wait(), timeout=1)
        armed.gate.release()
        await asyncio.wait_for(first, timeout=1)

        # 第二个事务不再被拦，因为门已经用掉了。
        await asyncio.wait_for(
            registry.hold_matching("after_commit", document_id="doc-1", tx_id="tx-2"), timeout=1
        )

    run(scenario())


def test_release_all_unblocks_every_armed_gate():
    async def scenario() -> None:
        registry = GateRegistry()
        await registry.arm("after_commit", document_id="doc-1")
        await registry.arm("before_ack_send", document_id="doc-1")

        holding = [
            asyncio.create_task(
                registry.hold_matching("after_commit", document_id="doc-1", tx_id="tx-1")
            ),
            asyncio.create_task(
                registry.hold_matching("before_ack_send", document_id="doc-1", tx_id="tx-1")
            ),
        ]
        for armed in await registry.armed_gates():
            await asyncio.wait_for(armed.gate.entered.wait(), timeout=1)
        for task in holding:
            assert not task.done()

        await registry.release_all()
        await asyncio.wait_for(asyncio.gather(*holding), timeout=1)

    run(scenario())


def test_two_gates_on_the_same_point_are_both_entered():
    """同时挂起多个门时必须并发等待；串行等待会让后面的门永远进不去。"""

    async def scenario() -> None:
        registry = GateRegistry()
        first_id = await registry.arm("before_ack_send", document_id="doc-1")
        second_id = await registry.arm("before_ack_send", document_id="doc-1")

        holding = asyncio.create_task(
            registry.hold_matching("before_ack_send", document_id="doc-1", tx_id="tx-1")
        )
        for gate_id in (first_id, second_id):
            armed = await registry.get(gate_id)
            await asyncio.wait_for(armed.gate.entered.wait(), timeout=1)
        assert not holding.done()

        await registry.release_all()
        await asyncio.wait_for(holding, timeout=1)

    run(scenario())


def test_hooks_forward_to_the_matching_gate():
    async def scenario() -> None:
        registry = GateRegistry()
        hooks = ControlledHooks(registry)
        gate_id = await registry.arm("before_sync_send", document_id="doc-1", sync_id="sync-1")

        holding = asyncio.create_task(
            hooks.before_sync_send("doc-1", "sync-1")
        )
        armed = await registry.get(gate_id)
        await asyncio.wait_for(armed.gate.entered.wait(), timeout=1)
        assert not holding.done()
        armed.gate.release()
        await asyncio.wait_for(holding, timeout=1)

    run(scenario())


# --- 控制接口 ---------------------------------------------------------------


@pytest.fixture
def controlled_app(database_path: Path):
    with TestClient(build_app(database_path, TOKEN)) as client:
        yield client


def test_control_api_requires_token(controlled_app: TestClient):
    denied = controlled_app.post("/control/gates", json={"point": "after_commit"})
    assert denied.status_code == 403

    wrong = controlled_app.post(
        "/control/gates",
        json={"point": "after_commit"},
        headers={"x-control-token": "nope"},
    )
    assert wrong.status_code == 403

    allowed = controlled_app.post(
        "/control/gates",
        json={"point": "after_commit"},
        headers={"x-control-token": TOKEN},
    )
    assert allowed.status_code == 200
    assert allowed.json()["gateId"]


def test_control_api_rejects_unknown_points_and_gates(controlled_app: TestClient):
    headers = {"x-control-token": TOKEN}
    created = controlled_app.post(
        "/control/gates", json={"point": "after_commit"}, headers=headers
    ).json()

    assert (
        controlled_app.post(
            "/control/gates/00000000-0000-0000-0000-000000000000/wait", headers=headers
        ).status_code
        == 404
    )
    assert (
        controlled_app.post(
            "/control/gates/00000000-0000-0000-0000-000000000000/release", headers=headers
        ).status_code
        == 404
    )
    assert (
        controlled_app.post(
            f"/control/gates/{created['gateId']}/release", headers=headers
        ).status_code
        == 200
    )


def test_control_api_rejects_unknown_fields(controlled_app: TestClient):
    response = controlled_app.post(
        "/control/gates",
        json={"point": "after_commit", "extra": 1},
        headers={"x-control-token": TOKEN},
    )
    assert response.status_code == 422


def test_production_app_has_no_control_routes(database_path: Path):
    with TestClient(create_app(database_path)) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        assert client.post("/control/gates", json={"point": "after_commit"}).status_code == 404
