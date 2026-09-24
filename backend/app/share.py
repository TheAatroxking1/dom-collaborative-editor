"""发现本机局域网 IPv4 候选；不探测外部服务或保证地址可达。"""

from __future__ import annotations

import socket
from ipaddress import IPv4Address, IPv4Network

RFC1918_NETWORKS = (
    IPv4Network("10.0.0.0/8"),
    IPv4Network("172.16.0.0/12"),
    IPv4Network("192.168.0.0/16"),
)


def lan_ipv4_hosts(local_host: str | None = None) -> list[str]:
    """每次重新发现地址，兼容换网；探测失败不影响文档服务。"""
    candidates = [local_host] if local_host else []
    try:
        addresses = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        addresses = []
    candidates.extend(address[4][0] for address in addresses)

    hosts: set[IPv4Address] = set()
    for candidate in candidates:
        try:
            address = IPv4Address(candidate)
        except ValueError:
            continue
        # is_private 还包括部分保留地址；这里明确只接受三个 RFC1918 网段。
        if any(address in network for network in RFC1918_NETWORKS):
            hosts.add(address)
    return [str(address) for address in sorted(hosts)]
