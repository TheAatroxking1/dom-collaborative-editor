"""局域网分享地址只暴露服务电脑的 RFC1918 IPv4 候选。"""

from __future__ import annotations

import socket
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


def mock_host_addresses(monkeypatch: pytest.MonkeyPatch, hosts: list[str]) -> None:
    monkeypatch.setattr(socket, "gethostname", lambda: "collab-server")

    def resolve(host: str, port: None, family: int):
        assert (host, port, family) == ("collab-server", None, socket.AF_INET)
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 0))
            for address in hosts
        ]

    monkeypatch.setattr(socket, "getaddrinfo", resolve)


def test_share_addresses_filter_deduplicate_and_sort(
    monkeypatch: pytest.MonkeyPatch, data_directory: Path
):
    mock_host_addresses(
        monkeypatch,
        [
            "192.168.2.10", "10.0.0.10", "10.0.0.2", "172.31.255.254",
            "192.168.2.10", "172.16.0.1", "127.0.0.1", "0.0.0.0",
            "169.254.1.2", "224.0.0.1", "8.8.8.8", "100.64.0.1",
            "172.15.255.255", "172.32.0.1", "192.0.0.1", "198.18.0.1",
            "::1", "not-an-address",
        ],
    )
    client = TestClient(create_app(data_directory))

    response = client.get("/api/share-addresses")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "hosts": ["10.0.0.2", "10.0.0.10", "172.16.0.1", "172.31.255.254", "192.168.2.10"]
    }
    assert not data_directory.exists()


def test_share_addresses_include_local_server_address_not_host_header(
    monkeypatch: pytest.MonkeyPatch, data_directory: Path
):
    mock_host_addresses(monkeypatch, ["192.168.1.2"])
    client = TestClient(create_app(data_directory), base_url="http://10.2.3.4:5274")

    response = client.get("/api/share-addresses", headers={"Host": "192.168.99.99"})

    assert response.status_code == 200
    assert response.json() == {"hosts": ["10.2.3.4", "192.168.1.2"]}


@pytest.mark.parametrize("failed_probe", ["gethostname", "getaddrinfo"])
def test_share_probe_failure_does_not_break_document_service(
    monkeypatch: pytest.MonkeyPatch, data_directory: Path, failed_probe: str
):
    mock_host_addresses(monkeypatch, [])

    def fail(*args):
        raise OSError("network information unavailable")

    monkeypatch.setattr(socket, failed_probe, fail)
    with TestClient(create_app(data_directory)) as client:
        response = client.get("/api/share-addresses")
        assert response.status_code == 200
        assert response.json() == {"hosts": []}
        assert response.headers["cache-control"] == "no-store"
        assert client.get("/api/health").json() == {"status": "ok"}
        document = client.post("/api/documents")
        assert document.status_code == 201
        document_id = document.json()["documentId"]
        assert client.get(f"/api/documents/{document_id}").status_code == 200


def test_share_probe_failure_can_still_use_local_server_address(
    monkeypatch: pytest.MonkeyPatch, data_directory: Path
):
    def fail(*args):
        raise socket.gaierror("hostname lookup failed")

    monkeypatch.setattr(socket, "getaddrinfo", fail)
    client = TestClient(create_app(data_directory), base_url="http://192.168.1.7:5274")

    assert client.get("/api/share-addresses").json() == {"hosts": ["192.168.1.7"]}


def test_share_addresses_are_recomputed_after_network_changes(
    monkeypatch: pytest.MonkeyPatch, data_directory: Path
):
    client = TestClient(create_app(data_directory))
    mock_host_addresses(monkeypatch, ["192.168.1.2"])
    assert client.get("/api/share-addresses").json() == {"hosts": ["192.168.1.2"]}

    mock_host_addresses(monkeypatch, ["10.0.0.2"])
    assert client.get("/api/share-addresses").json() == {"hosts": ["10.0.0.2"]}
