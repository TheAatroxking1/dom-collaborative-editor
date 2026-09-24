"""启动入口的地址选择、就绪后开浏览器与启动失败边界。"""

import asyncio
import socket
from contextlib import asynccontextmanager
from urllib.request import urlopen

import pytest
import uvicorn
from fastapi import FastAPI

import serve
from app.main import create_app


def test_default_urls_use_lan_addresses(monkeypatch):
    monkeypatch.setattr(serve, "lan_ipv4_hosts", lambda: ["192.168.1.8", "10.0.0.2"])
    assert serve.access_urls("0.0.0.0", 5274, False) == [
        "http://192.168.1.8:5274/", "http://10.0.0.2:5274/",
    ]


@pytest.mark.parametrize("host,expected", [
    ("127.0.0.1", "127.0.0.1"), ("192.168.1.8", "192.168.1.8"),
    ("::1", "[::1]"), ("::", "[::1]"), ("editor.local", "editor.local"),
])
def test_explicit_host_port_and_tls_are_preserved(host, expected):
    assert serve.access_urls(host, 9443, True) == [f"https://{expected}:9443/"]


def test_no_lan_address_falls_back_with_explanation(monkeypatch, capsys):
    monkeypatch.setattr(serve, "lan_ipv4_hosts", lambda: [])
    assert serve.access_urls("0.0.0.0", 5274, False) == ["http://127.0.0.1:5274/"]
    assert "未检测到局域网" in capsys.readouterr().out


def test_one_address_never_prompts(monkeypatch):
    def unexpected_input(*args):
        pytest.fail("一个地址无需选择")
    monkeypatch.setattr("builtins.input", unexpected_input)
    assert serve.choose_browser_url(["http://192.168.1.8:5274/"], None) == "http://192.168.1.8:5274/"


def test_multiple_addresses_require_valid_selection(monkeypatch, capsys):
    answers = iter(["", "invalid", "0", "3", "2"])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))
    urls = ["http://10.0.0.2:5274/", "http://192.168.1.8:5274/"]
    assert serve.choose_browser_url(urls, None) == urls[1]
    assert urls[1] in capsys.readouterr().out


def test_explicit_browser_host_skips_prompt_and_must_be_candidate(monkeypatch):
    def unexpected_input(*args):
        pytest.fail("显式指定地址无需选择")
    monkeypatch.setattr("builtins.input", unexpected_input)
    urls = ["http://10.0.0.2:5274/", "http://192.168.1.8:5274/"]
    assert serve.choose_browser_url(urls, "192.168.1.8") == urls[1]
    with pytest.raises(ValueError, match="browser-host"):
        serve.choose_browser_url(urls, "192.168.1.9")


def test_missing_terminal_input_explains_noninteractive_options(monkeypatch):
    def closed_input(*args):
        raise EOFError
    monkeypatch.setattr("builtins.input", closed_input)
    with pytest.raises(ValueError, match="--no-browser"):
        serve.choose_browser_url(["http://10.0.0.2:5274/", "http://192.168.1.8:5274/"], None)


@pytest.mark.parametrize("failure", [False, OSError("browser unavailable")])
def test_browser_failure_keeps_manual_url(monkeypatch, capsys, failure):
    def failed_open(*args, **kwargs):
        if isinstance(failure, Exception):
            raise failure
        return failure
    monkeypatch.setattr(serve.webbrowser, "open", failed_open)
    serve.open_browser("http://192.168.1.8:5274/")
    output = capsys.readouterr().out
    assert "手动打开" in output
    assert "http://192.168.1.8:5274/" in output


def test_browser_opens_only_after_real_http_service_is_ready(monkeypatch, data_directory, tmp_path):
    static = tmp_path / "dist"
    static.mkdir()
    (static / "index.html").write_text("LAN editor", encoding="utf-8")
    app = create_app(data_directory, static_directory=static)
    calls = []
    failures = []
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        url = f"http://127.0.0.1:{listener.getsockname()[1]}/"
        server = serve.BrowserServer(uvicorn.Config(app, log_level="warning"), [url], url)

        def check_ready(opened_url, **kwargs):
            try:
                assert server.started
                with urlopen(opened_url, timeout=3) as response:
                    assert response.read() == b"LAN editor"
                calls.append(opened_url)
            except Exception as error:
                failures.append(error)
            finally:
                server.should_exit = True
            return True

        monkeypatch.setattr(serve.webbrowser, "open", check_ready)
        asyncio.run(server.serve(sockets=[listener]))
    assert not failures
    assert calls == [url]
    assert app.state.collaboration is None  # 仍执行应用的正常关闭流程。


def test_occupied_port_does_not_open_browser(monkeypatch, data_directory):
    opened = []
    monkeypatch.setattr(serve.webbrowser, "open", lambda *args, **kwargs: opened.append(args))
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen()
        port = occupied.getsockname()[1]
        url = f"http://127.0.0.1:{port}/"
        server = serve.BrowserServer(
            uvicorn.Config(create_app(data_directory), host="127.0.0.1", port=port, log_level="warning"),
            [url], url,
        )
        with pytest.raises(SystemExit) as failure:
            asyncio.run(server.serve())
        assert failure.value.code == 3
    assert not opened


def test_no_browser_mode_never_prompts_or_opens(monkeypatch):
    monkeypatch.setattr(serve, "lan_ipv4_hosts", lambda: ["10.0.0.2", "192.168.1.8"])
    def unexpected(*args, **kwargs):
        pytest.fail("--no-browser 不应交互或打开浏览器")
    monkeypatch.setattr(serve, "choose_browser_url", unexpected)
    monkeypatch.setattr(serve.webbrowser, "open", unexpected)

    def run(server):
        assert server.browser_url is None
        assert server.config.host == "0.0.0.0"
        assert server.config.port == 6000
        assert server.config.workers == 1
        assert server.config.timeout_graceful_shutdown == 10
        server.started = True

    monkeypatch.setattr(serve.BrowserServer, "run", run)
    assert serve.main(["--no-browser", "--port", "6000"]) == 0


def test_application_startup_failure_does_not_open_browser(monkeypatch):
    @asynccontextmanager
    async def broken_lifespan(app):
        raise RuntimeError("storage cannot start")
        yield  # pragma: no cover

    opened = []
    monkeypatch.setattr(serve.webbrowser, "open", lambda *args, **kwargs: opened.append(args))
    url = "http://127.0.0.1:5274/"
    server = serve.BrowserServer(
        uvicorn.Config(FastAPI(lifespan=broken_lifespan), log_level="critical"), [url], url,
    )
    with pytest.raises(SystemExit) as failure:
        asyncio.run(server.serve())
    assert failure.value.code == 3
    assert not opened
