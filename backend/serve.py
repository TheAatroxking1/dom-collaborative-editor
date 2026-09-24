"""构建版桌面启动入口；地址检测复用后端，服务继续在前台运行。"""

from __future__ import annotations

import argparse
import threading
import webbrowser
from urllib.parse import urlsplit

import uvicorn

from app.share import lan_ipv4_hosts


def access_urls(host: str, port: int, secure: bool) -> list[str]:
    # IPv6 通配监听不保证接受 IPv4，不能为它生成 IPv4 分享地址。
    hosts = lan_ipv4_hosts() if host == "0.0.0.0" else ["::1" if host == "::" else host]
    if host == "::":
        print("IPv6 通配监听使用本机 [::1] 打开；需要 IPv4 局域网入口请使用 --host 0.0.0.0。", flush=True)
    if not hosts:
        print("未检测到局域网 IPv4，本次使用本机地址；其他电脑暂时无法访问。", flush=True)
        hosts = ["127.0.0.1"]
    scheme = "https" if secure else "http"
    return [f"{scheme}://{'[' + value + ']' if ':' in value else value}:{port}/" for value in hosts]


def choose_browser_url(urls: list[str], preferred_host: str | None) -> str:
    if preferred_host:
        for url in urls:
            if urlsplit(url).hostname == preferred_host:
                return url
        raise ValueError("--browser-host 必须是当前监听地址对应的候选 IP 或主机名。")
    if len(urls) == 1:
        return urls[0]
    print("检测到多个地址，请选择与另一台设备相通的网卡（VPN / 虚拟网卡不一定可用）：")
    for index, url in enumerate(urls, 1):
        print(f"  {index}. {url}")
    while True:
        try:
            choice = input("输入地址编号：").strip()
        except EOFError as error:
            raise ValueError("无法读取选择；请用 --browser-host 指定地址，或用 --no-browser 只启动服务。") from error
        if choice.isascii() and choice.isdigit() and 1 <= int(choice) <= len(urls):
            return urls[int(choice) - 1]
        print(f"请输入 1 到 {len(urls)} 的编号。")


def open_browser(url: str) -> None:
    try:
        if webbrowser.open(url, new=2):
            return
    except Exception as error:
        # 系统浏览器失败不能使已启动的编辑服务退出。
        print(f"无法自动打开浏览器：{error}", flush=True)
    print(f"请手动打开：{url}", flush=True)


class BrowserServer(uvicorn.Server):
    def __init__(self, config: uvicorn.Config, urls: list[str], browser_url: str | None):
        super().__init__(config)
        self.urls = urls
        self.browser_url = browser_url

    async def startup(self, sockets=None) -> None:
        await super().startup(sockets=sockets)
        if not self.started or self.should_exit:
            return
        for url in self.urls:
            print(f"访问地址：{url}", flush=True)
        if self.browser_url:
            print(f"正在打开：{self.browser_url}", flush=True)
            # macOS 的系统浏览器调用可能等待；不要阻塞事件循环或服务的正常退出。
            threading.Thread(target=open_browser, args=(self.browser_url,), daemon=True).start()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="启动协作编辑器，并默认打开局域网页面。")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5274)
    parser.add_argument("--ssl-certfile")
    parser.add_argument("--ssl-keyfile")
    parser.add_argument("--log-level", default="info", choices=["critical", "error", "warning", "info", "debug", "trace"])
    browser_options = parser.add_mutually_exclusive_group()
    browser_options.add_argument("--no-browser", action="store_true", help="不选择地址或打开浏览器，仅启动服务")
    browser_options.add_argument("--browser-host", help="指定打开的候选 IP / 主机名，跳过终端选择")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1 到 65535 之间。")
    if bool(args.ssl_certfile) != bool(args.ssl_keyfile):
        parser.error("--ssl-certfile 与 --ssl-keyfile 必须同时提供。")
    urls = access_urls(args.host, args.port, bool(args.ssl_certfile))
    try:
        browser_url = None if args.no_browser else choose_browser_url(urls, args.browser_host)
    except ValueError as error:
        parser.error(str(error))
    config = uvicorn.Config(
        "app.main:app", host=args.host, port=args.port, workers=1,
        timeout_graceful_shutdown=10, log_level=args.log_level,
        ssl_certfile=args.ssl_certfile, ssl_keyfile=args.ssl_keyfile,
    )
    server = BrowserServer(config, urls, browser_url)
    try:
        server.run()
    except KeyboardInterrupt:
        pass  # 与 Uvicorn CLI 一样：其信号处理已经完成正常停机。
    if not server.started:
        return 3
    if getattr(getattr(server, "lifespan", None), "shutdown_failed", False):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
