from __future__ import annotations

import errno
import json
import socket
from contextlib import closing
from http.client import HTTPConnection
from ipaddress import ip_address
from unittest.mock import Mock

import psutil
import pytest
from aiohttp.test_utils import make_mocked_request
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect

from fora.__main__ import parse_arguments
from fora.adapters.jsonl.protocol import Dispatcher
from fora.adapters.websocket import server as module
from fora.adapters.websocket.address import (
    matches_public_host,
    parse_authority,
    parse_origin,
    public_hosts,
)
from fora.adapters.websocket.server import WebServer


@pytest.mark.parametrize(
    ("environment", "arguments", "expected"),
    [
        (None, [], set()),
        ("", [], set()),
        (" A.example , .B.example ", [], {"a.example", ".b.example"}),
        ("invalid,,,", ["--public-host", "C.example"], {"c.example"}),
        (
            None,
            ["--public-host", "A.example", "--public-host", ".B.example"],
            {"a.example", ".b.example"},
        ),
        ("invalid,,,", ["--transport", "stdio"], set()),
    ],
)
def test_public_hosts_arguments(monkeypatch, environment, arguments, expected):
    monkeypatch.delenv("FORA_PUBLIC_HOSTS", raising=False)
    if environment is not None:
        monkeypatch.setenv("FORA_PUBLIC_HOSTS", environment)
    assert parse_arguments(arguments).public_hosts == expected


@pytest.mark.parametrize(
    "value",
    [
        "",
        "a.example,",
        ",a.example",
        "a.example,,b.example",
        " ",
        "*",
        "*.example.com",
        ".127.0.0.1",
        "http://a.example",
        "a.example:443",
        "a.example/",
        "user@a.example",
        "bad_name",
        "a..example",
        "a.example..",
        "a%2eexample",
        "[::1]",
        ".::1",
    ],
)
def test_invalid_public_hosts_fail_at_startup(monkeypatch, value):
    with pytest.raises(SystemExit) as failure:
        parse_arguments(["--public-host", value])
    assert failure.value.code == 2
    if value:
        monkeypatch.setenv("FORA_PUBLIC_HOSTS", value)
        with pytest.raises(SystemExit):
            parse_arguments([])


def test_stdio_rejects_explicit_public_host():
    with pytest.raises(SystemExit) as failure:
        parse_arguments(["--transport", "stdio", "--public-host", "a.example"])
    assert failure.value.code == 2


def test_public_host_normalization_and_label_boundaries():
    allowed = public_hosts(
        ["Bücher.Example.", ".Sub.Example.", "127.0.0.1", "0:0:0:0:0:0:0:1"]
    )
    assert allowed == {"xn--bcher-kva.example", ".sub.example", "127.0.0.1", "::1"}
    for value in (
        "sub.example",
        "a.sub.example",
        "a.b.sub.example",
        "xn--bcher-kva.example",
        "::1",
    ):
        assert matches_public_host(value, allowed)
    for value in (
        "badsub.example",
        "sub.example.attacker.test",
        "other.example",
        "a.xn--bcher-kva.example",
    ):
        assert not matches_public_host(value, allowed)
    assert parse_authority("Bücher.Example.:443", "https") == parse_origin(
        "https://xn--bcher-kva.example"
    )
    assert parse_authority("[0:0:0:0:0:0:0:1]:80") == parse_origin("http://[::1]")


@pytest.mark.parametrize(
    "value",
    [
        "",
        "a.example:",
        "a.example:bad",
        "a.example:65536",
        "a.example:-1",
        "a.example/path",
        "a.example/",
        "http://a.example",
        "a.example?",
        "a.example#",
        "user@a.example",
        "a\\example",
        "a%2eexample",
        "a.example..",
        "bad_name",
        "a.example,b.example",
        "[::1",
        "::1",
        "a.example\t",
        "a.example\x00",
    ],
)
def test_invalid_authorities(value):
    with pytest.raises(ValueError):
        parse_authority(value)


@pytest.fixture
def servers(tmp_path, monkeypatch):
    active = []

    async def collect(_):
        return frozenset({"homebox"})

    monkeypatch.setattr(module, "collect_names", collect)
    (tmp_path / "index.html").write_text(
        '<script type="module" crossorigin src="/entry.js"></script>'
        '<link rel="stylesheet" crossorigin href="/style.css">'
        '<div id="root">application</div>'
    )
    (tmp_path / "entry.js").write_text("export const value = 1")
    (tmp_path / "style.css").write_text("body { margin: 0 }")

    def create(host="127.0.0.1", allowed=()):
        server = WebServer(
            Dispatcher(),
            tmp_path,
            host=host,
            public_hosts=public_hosts(list(allowed)),
        )

        async def voice(connection):
            await connection.close()

        server.add_websocket_route("/voice", voice, max_msg_size=1024)
        server.start()
        active.append(server)
        return server

    try:
        yield create
    finally:
        for server in reversed(active):
            server.stop()


def request(server, method, path, headers=()):
    target = "::1" if server.ipv6 else "127.0.0.1"
    with closing(HTTPConnection(target, server.port, timeout=5)) as connection:
        connection.putrequest(method, path, skip_host=True)
        for key, value in headers:
            connection.putheader(key, value)
        connection.endheaders()
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()


def handshake(server, host, origin, path="ws"):
    target = "::1" if server.ipv6 else "127.0.0.1"
    return connect(
        f"ws://{host}/{path}",
        origin=origin,
        sock=socket.create_connection((target, server.port)),
        proxy=None,
    )


@pytest.mark.parametrize("binding", ["0.0.0.0", "::"])
def test_external_domain_without_configuration(servers, binding):
    if binding == "::":
        try:
            with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as probe:
                probe.bind(("::1", 0))
        except OSError as error:
            if error.errno not in (
                errno.EAFNOSUPPORT,
                errno.EADDRNOTAVAIL,
                errno.EPROTONOSUPPORT,
            ):
                raise
            pytest.skip("IPv6 loopback unavailable")
    server = servers(binding)
    authority = f"arbitrary.example:{server.port}"
    origin = f"http://{authority}"
    headers = [("Host", authority), ("Origin", origin)]
    for path in ("/", "/index.html", "/discussions/1", "/entry.js", "/style.css"):
        status, received, _ = request(server, "GET", path, headers)
        assert status == 200 and received["Access-Control-Allow-Origin"] == origin
    assert request(server, "GET", "/", [("Host", authority)])[0] == 200
    for path in ("ws", "voice"):
        with handshake(server, authority, origin, path=path) as connection:
            if path == "ws":
                connection.send(json.dumps({"id": 1, "method": "ping"}))
                assert json.loads(connection.recv(timeout=5))["result"] == {
                    "pong": None
                }
    for path in (
        "/ws",
        "/voice",
        "/uploads/missing/content",
        "/discussions/1/messages/1/attachments/missing/content",
    ):
        assert request(server, "OPTIONS", path, headers)[0] == 204
    for method, path in (
        ("PUT", "/uploads/missing/content"),
        ("GET", "/discussions/1/messages/1/attachments/missing/content"),
    ):
        assert request(server, method, path, headers)[0] == 404


@pytest.mark.parametrize("binding", ["127.0.0.1", "0.0.0.0"])
@pytest.mark.parametrize(
    "authority,origin",
    [
        ("public.example", "https://public.example"),
        ("PUBLIC.EXAMPLE.:443", "https://public.example"),
        ("public.example:8443", "https://public.example:8443"),
        ("public.example:8080", "http://public.example:8080"),
    ],
)
def test_proxy_preserved_host(servers, binding, authority, origin):
    server = servers(binding, ["public.example"] if binding == "127.0.0.1" else [])
    headers = [("Host", authority), ("Origin", origin)]
    for path in ("/", "/entry.js", "/style.css"):
        assert request(server, "GET", path, headers)[0] == 200
    assert request(server, "GET", "/", [("Host", authority)])[0] == 200
    with handshake(server, authority, origin) as connection:
        connection.send(json.dumps({"id": 1, "method": "ping"}))
        assert json.loads(connection.recv(timeout=5))["result"] == {"pong": None}


@pytest.mark.parametrize(
    "origin",
    [
        "https://public.example",
        "https://public.example:8443",
        "http://a.deep.sub.example:8080",
    ],
)
def test_proxy_rewritten_host(servers, origin):
    server = servers(allowed=["public.example", ".sub.example"])
    authority = f"127.0.0.1:{server.port}"
    headers = [("Host", authority), ("Origin", origin)]
    for path in ("/", "/entry.js", "/style.css"):
        assert request(server, "GET", path, headers)[0] == 200
    for path in ("/voice", "/uploads/missing/content"):
        status, received, _ = request(server, "OPTIONS", path, headers)
        assert status == 204 and received["Access-Control-Allow-Origin"] == origin
    with handshake(server, authority, origin):
        pass
    for value in (
        "https://badsub.example",
        "https://sub.example.attacker.test",
        "https://other.example",
    ):
        status, received, _ = request(
            server, "OPTIONS", "/voice", [("Host", authority), ("Origin", value)]
        )
        assert status == 403 and "Access-Control-Allow-Origin" not in received


@pytest.mark.parametrize(
    "origin",
    [
        "null",
        "https://other.example",
        "https://public.example:8443",
        "https://public.example:443,https://other.example",
        "ftp://public.example",
        "file://public.example",
        "https://user@public.example",
        "https://public.example/",
        "https://public.example:",
    ],
)
def test_external_cross_site_rejected_on_every_route(servers, origin):
    server = servers("0.0.0.0")
    headers = [
        ("Host", "public.example"),
        ("Origin", origin),
        ("Forwarded", "host=public.example;proto=https"),
        ("X-Forwarded-Host", "public.example"),
        ("X-Forwarded-Proto", "https"),
        ("X-Forwarded-Port", "443"),
    ]
    for method, path in (
        ("GET", "/"),
        ("GET", "/entry.js"),
        ("GET", "/style.css"),
        ("GET", "/ws"),
        ("GET", "/voice"),
        ("PUT", "/uploads/missing/content"),
        ("GET", "/discussions/1/messages/1/attachments/missing/content"),
        ("OPTIONS", "/voice"),
    ):
        status, received, _ = request(server, method, path, headers)
        assert status == 403 and "Access-Control-Allow-Origin" not in received
    with pytest.raises(InvalidStatus) as failure:
        handshake(server, "public.example", origin)
    assert failure.value.response.status_code == 403


def test_loopback_unregistered_host_and_notice(servers):
    server = servers()
    for origin in (
        None,
        f"http://127.0.0.1:{server.port}",
        "http://external.example",
    ):
        headers = [("Host", "external.example")]
        if origin is not None:
            headers.append(("Origin", origin))
        status, received, body = request(server, "GET", "/", headers)
        assert status == 403
        assert received["Cache-Control"] == "no-store"
        assert received["Referrer-Policy"] == "no-referrer"
        assert "Access-Control-Allow-Origin" not in received
        assert (
            b"Fora did not accept the address this page was opened from, so the page could not load."
            in body
        )
        assert (
            b"To use a domain with this instance, allow it at startup with --public-host (or FORA_PUBLIC_HOSTS)."
            in body
        )
        assert f'href="http://127.0.0.1:{server.port}/"'.encode() in body
        assert (
            b"<script" not in body
            and b"<link" not in body
            and b"external.example" not in body
        )
        for method, path in (
            ("GET", "/entry.js"),
            ("GET", "/style.css"),
            ("GET", "/ws"),
            ("GET", "/voice"),
            ("OPTIONS", "/"),
            ("PUT", "/uploads/missing/content"),
        ):
            status, received, body = request(server, method, path, headers)
            assert status == 403 and body == b"Origin not allowed"
            assert "Access-Control-Allow-Origin" not in received
    for name in ("homebox", "localhost", "127.0.0.1"):
        authority = f"{name}:{server.port}"
        assert request(server, "GET", "/", [("Host", authority)])[0] == 200
        for path in ("/", "/entry.js", "/style.css"):
            headers = [("Host", authority), ("Origin", f"http://{authority}")]
            assert request(server, "GET", path, headers)[0] == 200
        with handshake(server, authority, f"http://{authority}"):
            pass


@pytest.mark.parametrize("binding", ["127.0.0.1", "0.0.0.0"])
@pytest.mark.parametrize(
    "headers",
    [
        [("Host", "public.example"), ("Host", "public.example")],
        [
            ("Host", "public.example"),
            ("Origin", "https://public.example"),
            ("Origin", "https://public.example"),
        ],
        [("Host", "public.example/path")],
        [("Host", "user@public.example")],
        [("Host", "public.example:bad")],
        [("Host", "public.example:")],
        [("Host", "public.example:65536")],
        [("Host", "public.example,other.example")],
        [],
    ],
)
def test_invalid_or_duplicate_headers_rejected(servers, binding, headers):
    server = servers(binding, ["public.example"])
    for method, path in (
        ("GET", "/"),
        ("GET", "/entry.js"),
        ("OPTIONS", "/voice"),
        ("GET", "/ws"),
    ):
        status, received, _ = request(server, method, path, headers)
        assert status in (400, 403)
        assert "Access-Control-Allow-Origin" not in received


@pytest.mark.parametrize(
    "address,loopback",
    [
        ("::ffff:127.0.0.1", True),
        ("::ffff:192.0.2.1", False),
        ("192.0.2.1", False),
        ("::1", True),
    ],
)
def test_actual_binding_decides_scope(servers, address, loopback):
    server = servers()
    server._address = ip_address(address)
    assert server.loopback == loopback
    transport = Mock()
    transport.get_extra_info.return_value = (address, server.port)
    request = make_mocked_request(
        "GET", "/", headers={"Host": "public.example"}, transport=transport
    )
    assert server._allows_host(request) is not loopback
    assert server._allows_origin(request, "https://public.example") is not loopback


def test_fixed_nonloopback_binding_accepts_domain(servers):
    addresses = [
        entry.address
        for entries in psutil.net_if_addrs().values()
        for entry in entries
        if entry.family == socket.AF_INET
        and not ip_address(entry.address).is_loopback
        and not ip_address(entry.address).is_unspecified
    ]
    if not addresses:
        pytest.skip("No local non-loopback IPv4 address")
    server = servers(addresses[0])
    with closing(HTTPConnection(addresses[0], server.port, timeout=5)) as connection:
        connection.request(
            "OPTIONS",
            "/voice",
            headers={"Host": "public.example", "Origin": "https://public.example"},
        )
        response = connection.getresponse()
        response.read()
        assert response.status == 204
    assert not server.loopback
