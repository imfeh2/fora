from __future__ import annotations

import asyncio
import json
import socket
import sys
import threading
from contextlib import closing, nullcontext
from http.client import HTTPConnection
from ipaddress import ip_address
from pathlib import PureWindowsPath
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from aiohttp.test_utils import make_mocked_request
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect

from fora.adapters.jsonl.protocol import Dispatcher
from fora.adapters.websocket import local_names as names
from fora.adapters.websocket import server as module
from fora.adapters.websocket.address import parse_origin
from fora.adapters.websocket.server import WebServer


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("HOMEBOX.", "homebox"),
        ("Bücher.example", "xn--bcher-kva.example"),
        ("a-b", "a-b"),
    ],
)
def test_name_normalization(value, expected):
    assert names.normalize_name(value) == expected
    assert parse_origin(f"http://{value}:2461").raw_host == expected


@pytest.mark.parametrize(
    "value",
    [
        "",
        "homebox..",
        "*.example",
        "bad_name",
        "http://homebox",
        "homebox:2461",
        "user@host",
        "a/b",
        "a%20b",
        "127.0.0.1",
        "-host",
        "a" * 64,
    ],
)
def test_invalid_names(value):
    with pytest.raises(ValueError):
        names.normalize_name(value)


def test_hosts_real_library_read_only_and_address_filtering(tmp_path, monkeypatch):
    path = tmp_path / "hosts"
    body = "\ufeff# comment\n\n127.0.1.1 HOMEBOX.localdomain homebox unrelated.invalid # own\n127.0.0.1\tlocal-alias full.alias\n100.64.1.1 network-alias\n100.64.2.1 external-alias\n::1 ipv6-alias\n0.0.0.0 blocked\nff02::1 multicast\nnot-an-ip bad\n127.0.0.1 a/b\n"
    path.write_text(body, encoding="utf-8")
    interfaces = frozenset(map(ip_address, ("127.0.0.1", "100.64.1.1", "::1")))
    monkeypatch.setattr(
        names.socket, "getaddrinfo", Mock(side_effect=AssertionError("DNS"))
    )
    result = names.read_hosts(
        path, ip_address("127.0.0.1"), interfaces, {"homebox"}, linux=True
    )
    assert result == {"homebox.localdomain", "local-alias", "full.alias"}
    assert path.read_text(encoding="utf-8") == body
    result = names.read_hosts(
        path, ip_address("0.0.0.0"), interfaces, {"homebox"}, linux=True
    )
    assert result == {
        "homebox.localdomain",
        "local-alias",
        "full.alias",
        "network-alias",
    }
    assert names.read_hosts(path, ip_address("::"), interfaces, set(), linux=False) == {
        "ipv6-alias"
    }


def test_hosts_decode_failure_and_permissions_leave_os_names(tmp_path, monkeypatch):
    path = tmp_path / "hosts"
    monkeypatch.setattr(names, "hosts_path", lambda: path)
    monkeypatch.setattr(names.socket, "gethostname", lambda: "Own.Example")
    monkeypatch.setattr(names, "interface_addresses", lambda: frozenset())
    path.write_bytes(b"127.0.0.1 alias\n\xff")
    assert names.local_configuration(ip_address("127.0.0.1"))[0] == {
        "own.example",
        "own",
    }
    monkeypatch.setattr(
        names, "read_hosts", Mock(side_effect=PermissionError("private"))
    )
    assert names.local_configuration(ip_address("127.0.0.1"))[0] == {
        "own.example",
        "own",
    }


def test_interface_addresses_only_local_numeric_values(monkeypatch):
    monkeypatch.setattr(
        names.psutil,
        "net_if_addrs",
        lambda: {
            "nic": [
                SimpleNamespace(family=socket.AF_INET, address="100.64.1.1"),
                SimpleNamespace(family=socket.AF_INET6, address="::1"),
                SimpleNamespace(family=socket.AF_INET6, address="fe80::1%eth0"),
                SimpleNamespace(family=socket.AF_INET, address="0.0.0.0"),
                SimpleNamespace(family=socket.AF_INET, address="224.0.0.1"),
                SimpleNamespace(family=999, address="unrelated"),
            ]
        },
    )
    assert names.interface_addresses() == frozenset(
        map(ip_address, ("100.64.1.1", "::1"))
    )


def tailnet_status(**changes):
    status = {
        "BackendState": "Running",
        "Self": {
            "Online": True,
            "DNSName": "Homebox.tail.ts.net.",
            "TailscaleIPs": ["100.64.1.1"],
            "HostName": "untrusted",
        },
        "CurrentTailnet": {"MagicDNSSuffix": "tail.ts.net"},
        "Peer": {"other": {"DNSName": "external.tail.ts.net."}},
    }
    status.update(changes)
    return json.dumps(status).encode()


def test_tailscale_self_only_and_binding():
    bound = ip_address("100.64.1.1")
    interfaces = frozenset({bound})
    assert names.tailscale_names(tailnet_status(), bound, interfaces) == {
        "homebox",
        "homebox.tail.ts.net",
    }
    assert (
        names.tailscale_names(tailnet_status(), ip_address("127.0.0.1"), interfaces)
        == set()
    )
    assert names.tailscale_names(
        tailnet_status(), ip_address("0.0.0.0"), interfaces
    ) == {"homebox", "homebox.tail.ts.net"}
    assert (
        names.tailscale_names(tailnet_status(), ip_address("::"), interfaces) == set()
    )
    assert names.tailscale_names(
        tailnet_status(CurrentTailnet={"MagicDNSSuffix": "evil.ts.net"}),
        bound,
        interfaces,
    ) == {"homebox.tail.ts.net"}


@pytest.mark.parametrize(
    "changes",
    [
        {"BackendState": "Stopped"},
        {"BackendState": "NeedsLogin"},
        {"Self": None},
        {
            "Self": {
                "Online": False,
                "DNSName": "homebox.tail.ts.net",
                "TailscaleIPs": ["100.64.1.1"],
            }
        },
        {"Self": {"Online": True, "DNSName": 123, "TailscaleIPs": ["100.64.1.1"]}},
        {
            "Self": {
                "Online": True,
                "DNSName": "homebox.tail.ts.net",
                "TailscaleIPs": [123],
            }
        },
    ],
)
def test_tailscale_unavailable(changes):
    assert (
        names.tailscale_names(
            tailnet_status(**changes), ip_address("100.64.1.1"), frozenset()
        )
        == set()
    )


def test_macos_configuration_and_missing_cli(monkeypatch):
    calls = []
    monkeypatch.setattr(names.sys, "platform", "darwin")
    monkeypatch.setattr(names, "local_configuration", lambda _: ({"base"}, frozenset()))
    monkeypatch.setattr(names.shutil, "which", lambda _: None)

    async def command(argv, deadline):
        calls.append((argv, deadline))
        return b"Own.Example\n" if argv[-1] == "HostName" else b"Bonjour\n"

    monkeypatch.setattr(names, "command", command)
    assert asyncio.run(names.collect_names(ip_address("127.0.0.1"))) == {
        "base",
        "own",
        "own.example",
        "bonjour",
        "bonjour.local",
    }
    assert len(calls) == 2 and calls[0][1] == calls[1][1]
    assert calls[0][0] == ("/usr/sbin/scutil", "--get", "HostName")


def test_windows_name_api_size_and_unavailable(monkeypatch):
    query = Mock()

    def read(kind, buffer, size):
        if buffer is None:
            size._obj.value = 16
            return False
        buffer.value = "Own" if kind == 5 else "Own.Example"
        return True

    query.side_effect = read
    monkeypatch.setattr(
        names.ctypes,
        "WinDLL",
        lambda *args, **kwargs: SimpleNamespace(GetComputerNameExW=query),
        raising=False,
    )
    monkeypatch.setattr(names.ctypes, "get_last_error", lambda: 234, raising=False)
    assert names.windows_names() == ["Own", "Own.Example"]
    assert [call.args[0] for call in query.call_args_list] == [5, 5, 7, 7]
    monkeypatch.setattr(names.ctypes, "get_last_error", lambda: 5)
    assert names.windows_names() == []


@pytest.mark.parametrize(
    "value", [r"D:\Windows\System32\drivers\etc", r"\\server\share", "relative"]
)
def test_windows_hosts_local_path(value, monkeypatch):
    registry = SimpleNamespace(
        OpenKey=lambda *args: nullcontext(object()),
        QueryValueEx=lambda *args: (value, 1),
        HKEY_LOCAL_MACHINE=1,
        KEY_READ=2,
        KEY_WOW64_64KEY=4,
        REG_SZ=1,
        REG_EXPAND_SZ=2,
    )
    monkeypatch.setitem(sys.modules, "winreg", registry)
    monkeypatch.setattr(
        names.ctypes,
        "WinDLL",
        lambda *args, **kwargs: SimpleNamespace(ExpandEnvironmentStringsW=Mock()),
        raising=False,
    )
    monkeypatch.setattr(names, "Path", PureWindowsPath)
    if value.startswith("D:"):
        assert str(names.windows_hosts_path()) == value + r"\hosts"
    else:
        with pytest.raises(ValueError):
            names.windows_hosts_path()


def test_command_real_timeout_cancellation_and_nonzero(monkeypatch):
    processes = []
    original = asyncio.create_subprocess_exec

    async def start(*args, **kwargs):
        process = await original(*args, **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", start)

    async def run():
        loop = asyncio.get_running_loop()
        assert (
            await names.command((sys.executable, "-c", "print('ok')"), loop.time() + 5)
            == b"ok\n"
        )
        assert (
            await names.command(
                (sys.executable, "-c", "raise SystemExit(3)"), loop.time() + 5
            )
            is None
        )
        assert (
            await names.command(
                (sys.executable, "-c", "import time; time.sleep(20)"), loop.time() + 0.1
            )
            is None
        )
        task = asyncio.create_task(
            names.command(
                (sys.executable, "-c", "import time; time.sleep(20)"), loop.time() + 5
            )
        )
        while len(processes) < 4:
            await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert all(process.returncode is not None for process in processes)

    asyncio.run(run())


@pytest.fixture
def site(tmp_path, monkeypatch):
    async def collect(_):
        return frozenset({"homebox", "homebox.localdomain", "xn--bcher-kva.example"})

    monkeypatch.setattr(module, "collect_names", collect)
    (tmp_path / "index.html").write_text(
        '<div id="root"></div><script crossorigin src="/entry.js"></script>'
    )
    (tmp_path / "entry.js").write_text("export const value=1")
    (tmp_path / "style.css").write_text("body { margin: 0 }")
    server = WebServer(Dispatcher(), "test-token", tmp_path)
    server.start()
    try:
        yield server
    finally:
        server.stop()


def request(server, method, path, headers=None):
    with closing(HTTPConnection("127.0.0.1", server.port, timeout=5)) as connection:
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()


def test_allowed_names_resources_real_handshake(site):
    for host in ("homebox", "HOMEBOX.", "homebox.localdomain", "xn--bcher-kva.example"):
        origin = f"http://{host}:{site.port}"
        headers = {"Host": f"{host}:{site.port}", "Origin": origin}
        for path in ("/", "/discussions/1", "/index.html", "/entry.js", "/style.css"):
            assert request(site, "GET", path, headers)[0] == 200
        with connect(
            f"ws://{host}:{site.port}/ws?token=test-token",
            sock=socket.create_connection(("127.0.0.1", site.port)),
            origin=origin,
            proxy=None,
        ) as connection:
            connection.send(
                json.dumps({"id": 1, "method": "ping", "params": {"token": "check"}})
            )
            assert json.loads(connection.recv(timeout=5))["result"] == {"pong": "check"}


def test_rejected_document_is_self_contained_and_socket_link(site):
    expected = None
    for host in ("external.invalid", "evil.invalid"):
        for origin in (None, "http://external.invalid", "null", site.access_origin):
            headers = {"Host": f"{host}:{site.port}"}
            if origin is not None:
                headers["Origin"] = origin
            for path in ("/", "/index.html", "/discussions/1", "/%69ndex.html"):
                status, response_headers, body = request(site, "GET", path, headers)
                assert status == 403 and response_headers["Content-Type"].startswith(
                    "text/html"
                )
                assert response_headers["Cache-Control"] == "no-store"
                assert response_headers["Referrer-Policy"] == "no-referrer"
                assert "Access-Control-Allow-Origin" not in response_headers
                assert b"This address is not allowed" in body
                assert (
                    b"<script" not in body
                    and b"<link" not in body
                    and b"<img" not in body
                )
                assert b"http://127.0.0.1:" + str(site.port).encode() + b"/" in body
                assert b'rel="noreferrer"' in body
                assert host.encode() not in body and b"token=" not in body
                assert expected is None or body == expected
                expected = body


def test_origin_rejection_protocols_and_authentication(site):
    bad = {"Host": f"homebox:{site.port}", "Origin": "http://external.invalid"}
    good = {"Host": f"homebox:{site.port}", "Origin": f"http://homebox:{site.port}"}
    for path in ("/entry.js", "/style.css", "/missing.js"):
        status, headers, body = request(site, "GET", path, bad)
        assert status == 403 and body == b"Origin not allowed"
        assert headers["Content-Type"].startswith("text/plain")
    for path in (
        "/",
        "/uploads/missing/content",
        "/discussions/1/messages/1/attachments/missing/content",
    ):
        assert request(site, "OPTIONS", path, bad)[0] == 403
        assert request(site, "OPTIONS", path, good)[0] == 204
    for method, path in (
        ("PUT", "/uploads/missing/content"),
        ("GET", "/discussions/1/messages/1/attachments/missing/content"),
    ):
        assert request(site, method, path, bad)[0] == 403
        assert request(site, method, path, good)[0] == 401
        assert (
            request(site, method, path, {**good, "Authorization": "Bearer test-token"})[
                0
            ]
            == 404
        )
    assert request(site, "GET", "/ws?token=test-token", {"Origin": "null"})[0] == 204
    assert request(site, "GET", "/ws", {"Origin": "null"})[0] == 401
    for origin, token, expected in (
        (bad["Origin"], "test-token", 403),
        (site.access_origin, "wrong", 401),
    ):
        with pytest.raises(InvalidStatus) as failure:
            connect(
                f"ws://127.0.0.1:{site.port}/ws?token={token}",
                origin=origin,
                proxy=None,
            )
        assert failure.value.response.status_code == expected


def test_name_origin_requires_authority_socket_and_actual_port(site):
    origin = f"http://homebox:{site.port}"
    transport = Mock()
    transport.get_extra_info.return_value = ("127.0.0.1", site.port)
    valid = make_mocked_request(
        "GET", "/", headers={"Host": f"homebox:{site.port}"}, transport=transport
    )
    assert site._allows_origin(valid, origin)
    assert not site._allows_origin(valid, "http://external.invalid:" + str(site.port))
    assert not site._allows_origin(valid, "https://homebox:" + str(site.port))
    assert not site._allows_origin(valid, "http://homebox:" + str(site.port + 1))
    forged = make_mocked_request(
        "GET",
        "/",
        headers={"Host": f"external.invalid:{site.port}"},
        transport=transport,
    )
    assert not site._allows_origin(forged, origin)
    transport.get_extra_info.return_value = ("127.0.0.2", site.port)
    assert not site._allows_origin(valid, origin)
    transport.get_extra_info.return_value = None
    assert not site._allows_origin(valid, origin)


def test_refresh_ready_deletion_single_flight_stop(monkeypatch):
    started = threading.Event()
    released = threading.Event()
    calls = []
    active = 0
    maximum = 0

    async def collect(_):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        calls.append(len(calls))
        try:
            if len(calls) == 1:
                return frozenset({"old"})
            if len(calls) == 2:
                return frozenset()
            started.set()
            await module.worker(released.wait)
            return frozenset({"new"})
        finally:
            active -= 1

    monkeypatch.setattr(module, "collect_names", collect)
    monkeypatch.setattr(module, "REFRESH_INTERVAL", 0.01)
    server = WebServer(Dispatcher(), "test-token", None)
    server.start()
    assert server._names == {"old"}
    try:
        assert started.wait(5)
        assert server._names == set()
        stopped = threading.Event()

        def stop():
            server.stop()
            stopped.set()

        thread = threading.Thread(target=stop)
        thread.start()
        try:
            assert not stopped.wait(0.05)
        finally:
            released.set()
            thread.join(5)
        assert stopped.is_set() and active == 0 and maximum == 1
        assert server._names == set()
    finally:
        released.set()
        server.stop()


def test_requests_use_snapshot_without_source_io(site, monkeypatch):
    failed = Mock(side_effect=AssertionError("Source I/O on request"))
    monkeypatch.setattr(names, "local_configuration", failed)
    monkeypatch.setattr(names, "interface_addresses", failed)
    monkeypatch.setattr(names, "hosts_path", failed)
    monkeypatch.setattr(names.shutil, "which", failed)
    headers = {"Host": f"homebox:{site.port}", "Origin": f"http://homebox:{site.port}"}
    assert request(site, "GET", "/", headers)[0] == 200
    assert request(site, "GET", "/entry.js", headers)[0] == 200
    assert request(site, "OPTIONS", "/", headers)[0] == 204
    failed.assert_not_called()


def test_name_default_port_ipv6_and_missing_socket(site):
    site._port = 80
    site._address = ip_address("::")
    transport = Mock()
    transport.get_extra_info.return_value = ("::1", 80, 0, 0)
    valid = make_mocked_request(
        "GET", "/", headers={"Host": "HOMEBOX.:80"}, transport=transport
    )
    assert site._allows_origin(valid, "http://homebox")
    assert site._allows_origin(valid, "http://HOMEBOX.:80")
    transport.get_extra_info.return_value = ("127.0.0.1", 80)
    assert not site._allows_origin(valid, "http://homebox")
    transport.get_extra_info.return_value = ("::1", 81, 0, 0)
    assert not site._allows_origin(valid, "http://homebox")


def test_static_notice_without_socket_and_ipv6_link(tmp_path):
    (tmp_path / "index.html").write_text("application")
    denied = module.static_response(tmp_path, "/", document_allowed=False)
    assert denied.status == 403 and denied.text == "Origin not allowed"
    denied = module.static_response(
        tmp_path, "/", document_allowed=False, entry_url="http://[::1]/"
    )
    assert denied.status == 403 and 'href="http://[::1]/"' in denied.text
    assert (
        module.static_response(tmp_path / "missing", "/", document_allowed=False).status
        == 503
    )


@pytest.mark.parametrize(
    "output", [None, b"{", b"[]", b"\xff", b'{"BackendState":"Stopped"}']
)
def test_collect_invalid_network_source_keeps_os(output, monkeypatch, caplog):
    monkeypatch.setattr(names.sys, "platform", "linux")
    monkeypatch.setattr(names, "local_configuration", lambda _: ({"own"}, frozenset()))
    monkeypatch.setattr(names.shutil, "which", lambda _: "/local/tailscale")

    async def command(argv, deadline):
        assert argv == ("/local/tailscale", "status", "--json", "--peers=false")
        return output

    monkeypatch.setattr(names, "command", command)
    assert asyncio.run(names.collect_names(ip_address("127.0.0.1"))) == {"own"}
    assert "AuthURL" not in caplog.text


def test_collect_cancel_waits_configuration_worker(monkeypatch):
    started = threading.Event()
    released = threading.Event()
    finished = threading.Event()

    def local(_):
        started.set()
        released.wait(5)
        finished.set()
        return {"own"}, frozenset()

    monkeypatch.setattr(names, "local_configuration", local)

    async def run():
        task = asyncio.create_task(names.collect_names(ip_address("127.0.0.1")))
        while not started.is_set():
            await asyncio.sleep(0.001)
        task.cancel()
        await asyncio.sleep(0.01)
        assert not task.done()
        released.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set()

    try:
        asyncio.run(run())
    finally:
        released.set()


def test_startup_failure_releases_owned_resources(monkeypatch):
    async def collect(_):
        raise RuntimeError("Source implementation failure")

    monkeypatch.setattr(module, "collect_names", collect)
    server = WebServer(Dispatcher(), "test-token", None)
    with pytest.raises(RuntimeError, match="Source implementation failure"):
        server.start()
    assert server._socket.fileno() == -1
    assert server._executor._shutdown
    assert not server._thread.is_alive()
