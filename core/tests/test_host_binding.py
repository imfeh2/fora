from __future__ import annotations

import errno
import json
import socket
from contextlib import closing
from http.client import HTTPConnection
from unittest.mock import Mock

import pytest
from aiohttp import web
from aiohttp.test_utils import make_mocked_request
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect
from yarl import URL

from fora.__main__ import parse_arguments
from fora.adapters.jsonl.protocol import Dispatcher
from fora.adapters.websocket import server as module
from fora.adapters.websocket.address import (
    HOST,
    http_origin,
    parse_origin,
    validate_host,
)
from fora.adapters.websocket.server import WebServer


@pytest.mark.parametrize(
    ("environment", "arguments", "expected"),
    [
        (None, [], HOST),
        ("", [], HOST),
        ("0.0.0.0", [], "0.0.0.0"),
        ("0.0.0.0", ["--host", "127.0.0.1"], HOST),
        ("invalid host", ["--host=::1"], "::1"),
        (None, ["--host", "LOCALHOST"], "localhost"),
    ],
)
def test_host_argument_precedence(monkeypatch, environment, arguments, expected):
    monkeypatch.delenv("FORA_HOST", raising=False)
    if environment is not None:
        monkeypatch.setenv("FORA_HOST", environment)
    assert parse_arguments(arguments).host == expected


@pytest.mark.parametrize("environment", ["invalid host", "::", "http://example.com"])
def test_stdio_ignores_host_environment(monkeypatch, environment):
    monkeypatch.setenv("FORA_HOST", environment)
    assert parse_arguments(["--transport", "stdio"]).host is None


@pytest.mark.parametrize("arguments", [["--host", HOST], ["--host="], ["--host=::"]])
def test_stdio_rejects_explicit_host(arguments, capsys):
    with pytest.raises(SystemExit) as failure:
        parse_arguments(["--transport", "stdio", *arguments])
    assert failure.value.code == 2
    assert (
        "--host is only supported with --transport websocket" in capsys.readouterr().err
    )


@pytest.mark.parametrize(
    "value",
    [
        "",
        " ",
        "host name",
        "host\nname",
        "host\x00name",
        "host\x7fname",
        "http://localhost",
        "localhost:2461",
        "localhost/",
        "localhost/path",
        "user@localhost",
        "localhost?query",
        "localhost#fragment",
        "[::1]",
        "[::1]:2461",
        "fe80::1%eth0",
        "localhost%2fpath",
        "localhost\\path",
    ],
)
def test_invalid_host_values_fail_at_argument_parsing(monkeypatch, value, capsys):
    with pytest.raises(SystemExit) as failure:
        parse_arguments(["--host", value])
    assert failure.value.code == 2
    assert "invalid --host" in capsys.readouterr().err
    if value and "\x00" not in value:
        monkeypatch.setenv("FORA_HOST", value)
        with pytest.raises(SystemExit):
            parse_arguments([])


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (HOST, HOST),
        ("::", "::"),
        ("0:0:0:0:0:0:0:1", "::1"),
        ("Example.COM", "example.com"),
    ],
)
def test_host_normalization(value, expected):
    assert validate_host(value) == expected


@pytest.mark.parametrize(
    ("host", "port", "expected"),
    [
        (HOST, 80, "http://127.0.0.1"),
        ("::1", 2461, "http://[::1]:2461"),
        ("::", 80, "http://[::]"),
    ],
)
def test_url_construction(host, port, expected):
    assert http_origin(host, port) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("http://LOCALHOST:80", "http://localhost"),
        ("http://[0:0:0:0:0:0:0:1]:80", "http://[::1]"),
        ("tauri://localhost", "tauri://localhost"),
    ],
)
def test_origin_normalization(value, expected):
    assert str(parse_origin(value)) == expected


@pytest.mark.parametrize(
    "value",
    [
        "null",
        "http://a/",
        "http://a/path",
        "http://user@a",
        "http://user:pass@a",
        "http://a?",
        "http://a#",
        "http://a?q=1",
        "http://a#fragment",
        "http://a:bad",
        "http://[fe80::1%25eth0]",
        "http://a\n",
        " http://a",
        "http://a:65536",
    ],
)
def test_invalid_origins(value):
    with pytest.raises(ValueError):
        parse_origin(value)


@pytest.fixture
def ipv6():
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
        pytest.skip(f"IPv6 loopback unavailable: {error}")


@pytest.mark.parametrize("host", [HOST, "0.0.0.0", "::1", "::"])
def test_bind_access_link_and_shutdown(host, request):
    if ":" in host:
        request.getfixturevalue("ipv6")
    server = WebServer(Dispatcher(), "test-token", None, 0, host=host)
    server.start()
    try:
        bound = server._socket.getsockname()
        assert bound[0] == host
        assert bound[1] == server.port > 0
        assert server.ipv6 == (":" in host)
        assert server.wildcard == (host in ("0.0.0.0", "::"))
        expected = "::1" if ":" in host else HOST
        assert server.access_origin == http_origin(expected, server.port)
        token = "test token/+?#&中文"
        url = URL(server.access_url(token))
        assert url.host == expected
        assert url.port == server.port
        assert url.query["token"] == token
        if server.ipv6:
            assert (
                server._socket.getsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY) == 1
            )
        endpoint = (
            URL(server.access_origin)
            .with_scheme("ws")
            .with_path("/ws")
            .with_query(token="test-token")
        )
        with connect(
            str(endpoint), origin=server.access_origin, proxy=None
        ) as connection:
            connection.send(json.dumps({"id": 1, "method": "ping"}))
            assert json.loads(connection.recv(timeout=5))["result"] == {"pong": None}
        with pytest.raises(InvalidStatus) as failure:
            connect(
                str(endpoint.with_query(token="wrong")),
                origin=server.access_origin,
                proxy=None,
            )
        assert failure.value.response.status_code == 401
    finally:
        server.stop()
    assert server._socket.fileno() == -1
    assert server._executor._shutdown
    assert not server._thread.is_alive()
    server.stop()


def test_hostname_uses_first_resolution_and_accepts_name_and_ip(monkeypatch, caplog):
    resolving = Mock(
        return_value=[
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (HOST, 0)),
            (
                socket.AF_INET6,
                socket.SOCK_STREAM,
                socket.IPPROTO_TCP,
                "",
                ("::1", 0, 0, 0),
            ),
        ]
    )
    monkeypatch.setattr(module.socket, "getaddrinfo", resolving)
    with caplog.at_level("INFO"):
        server = WebServer(Dispatcher(), "test-token", None, host="LOCALHOST")
    try:
        resolving.assert_called_once_with(
            "localhost", 0, socket.AF_UNSPEC, socket.SOCK_STREAM, socket.IPPROTO_TCP
        )
        assert server.listening_origin == http_origin(HOST, server.port)
        assert "selected" in caplog.text and server.listening_origin in caplog.text
        for host in (HOST, "localhost", "LOCALHOST"):
            request = make_mocked_request(
                "GET", "/ws", headers={"Host": f"{host}:{server.port}"}
            )
            assert server._allows_origin(request, f"http://{host}:{server.port}")
    finally:
        server.stop()


def test_wildcard_origin_uses_local_connection_and_host():
    server = WebServer(Dispatcher(), "test-token", None, host="0.0.0.0")
    local = "192.0.2.25"
    origin = http_origin(local, server.port)
    transport = Mock()
    transport.get_extra_info.return_value = (local, server.port)
    try:
        request = make_mocked_request(
            "GET",
            "/ws",
            headers={"Host": f"{local}:{server.port}"},
            transport=transport,
        )
        assert server._allows_origin(request, origin)
        for value in (
            f"http://{local}:{server.port + 1}",
            f"https://{local}:{server.port}",
            f"http://192.0.2.26:{server.port}",
            f"http://external.invalid:{server.port}",
            f"http://user@{local}:{server.port}",
            f"http://{local}:{server.port}/",
            "null",
        ):
            assert not server._allows_origin(request, value)
        forged = make_mocked_request(
            "GET",
            "/ws",
            headers={"Host": f"external.invalid:{server.port}"},
            transport=transport,
        )
        assert not server._allows_origin(forged, origin)
        transport.get_extra_info.return_value = None
        assert not server._allows_origin(request, origin)
    finally:
        server.stop()


def test_wildcard_ipv6_normalizes_local_address(ipv6):
    server = WebServer(Dispatcher(), "test-token", None, host="::")
    transport = Mock()
    transport.get_extra_info.return_value = ("2001:db8::25", server.port, 0, 0)
    request = make_mocked_request(
        "GET",
        "/ws",
        headers={"Host": f"[2001:db8::25]:{server.port}"},
        transport=transport,
    )
    try:
        assert server._allows_origin(
            request, f"http://[2001:0db8:0:0:0:0:0:25]:{server.port}"
        )
    finally:
        server.stop()


@pytest.mark.parametrize("host", [HOST, "0.0.0.0"])
def test_shared_origin_boundary_and_authentication(host):
    server = WebServer(Dispatcher(), "test-token", None, host=host)

    async def voice(connection):
        await connection.close()

    server.add_websocket_route("/voice", voice, max_msg_size=1024)
    server.start()
    try:
        for path in (
            "/voice",
            "/uploads/missing/content",
            "/discussions/1/messages/1/attachments/missing/content",
            "/",
        ):
            with closing(HTTPConnection(HOST, server.port, timeout=5)) as connection:
                connection.request(
                    "OPTIONS", path, headers={"Origin": server.access_origin}
                )
                response = connection.getresponse()
                response.read()
                assert response.status == 204
                assert (
                    response.getheader("Access-Control-Allow-Origin")
                    == server.access_origin
                )
                connection.request(
                    "OPTIONS", path, headers={"Origin": "http://external.invalid"}
                )
                response = connection.getresponse()
                response.read()
                assert response.status == 403
                assert response.getheader("Access-Control-Allow-Origin") is None
        for origin in (
            None,
            server.access_origin,
            "http://localhost:1420",
            "tauri://localhost",
            "http://tauri.localhost",
        ):
            for token in ("", "wrong", "test-token"):
                endpoint = f"ws://{HOST}:{server.port}/ws?token={token}"
                if token == "test-token":
                    with connect(endpoint, origin=origin, proxy=None):
                        pass
                else:
                    with pytest.raises(InvalidStatus) as failure:
                        connect(endpoint, origin=origin, proxy=None)
                    assert failure.value.response.status_code == 401
        with pytest.raises(InvalidStatus) as failure:
            connect(
                f"ws://{HOST}:{server.port}/voice?token=test-token",
                origin="null",
                proxy=None,
            )
        assert failure.value.response.status_code == 403
        with closing(HTTPConnection(HOST, server.port, timeout=5)) as connection:
            connection.request(
                "GET", "/ws?token=test-token", headers={"Origin": "null"}
            )
            response = connection.getresponse()
            response.read()
            assert response.status == 204
            assert response.getheader("Access-Control-Allow-Origin") is None
            connection.request(
                "PUT",
                "/uploads/missing/content",
                headers={"Origin": server.access_origin},
            )
            response = connection.getresponse()
            response.read()
            assert response.status == 401
            assert (
                response.getheader("Access-Control-Allow-Origin")
                == server.access_origin
            )
    finally:
        server.stop()


def test_dns_failure_creates_no_socket_or_executor(monkeypatch):
    failure = socket.gaierror(socket.EAI_NONAME, "test DNS failure")
    monkeypatch.setattr(module.socket, "getaddrinfo", Mock(side_effect=failure))
    created = Mock()
    executor = Mock()
    monkeypatch.setattr(module.socket, "socket", created)
    monkeypatch.setattr(module, "ThreadPoolExecutor", executor)
    with pytest.raises(socket.gaierror, match="test DNS failure"):
        WebServer(Dispatcher(), "test-token", None, host="example.invalid")
    created.assert_not_called()
    executor.assert_not_called()


@pytest.mark.parametrize("operation", ["bind", "listen", "setblocking"])
def test_socket_failure_closes_before_executor_creation(monkeypatch, operation):
    listener = Mock()
    getattr(listener, operation).side_effect = OSError("test socket failure")
    monkeypatch.setattr(module.socket, "socket", Mock(return_value=listener))
    executor = Mock()
    monkeypatch.setattr(module, "ThreadPoolExecutor", executor)
    with pytest.raises(OSError, match="test socket failure"):
        WebServer(Dispatcher(), "test-token", None)
    listener.close.assert_called_once()
    executor.assert_not_called()


def test_route_registration_failure_closes_socket_and_executor(monkeypatch):
    resources = []
    original = module.ThreadPoolExecutor

    def executor(*args, **kwargs):
        result = original(*args, **kwargs)
        resources.append(result)
        return result

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    monkeypatch.setattr(module.socket, "socket", Mock(return_value=listener))
    monkeypatch.setattr(module, "ThreadPoolExecutor", executor)
    monkeypatch.setattr(
        WebServer,
        "add_websocket_route",
        Mock(side_effect=RuntimeError("test route failure")),
    )
    with pytest.raises(RuntimeError, match="test route failure"):
        WebServer(Dispatcher(), "test-token", None)
    assert listener.fileno() == -1
    assert resources[0]._shutdown


def test_start_route_failure_closes_unstarted_service(monkeypatch):
    server = WebServer(Dispatcher(), "test-token", None)
    monkeypatch.setattr(
        server._app.router,
        "add_route",
        Mock(side_effect=RuntimeError("test start route failure")),
    )
    with pytest.raises(RuntimeError, match="test start route failure"):
        server.start()
    assert server._socket.fileno() == -1
    assert server._executor._shutdown
    assert server._thread.ident is None
    server.stop()


def test_thread_start_failure_cleans_unstarted_service(monkeypatch):
    server = WebServer(Dispatcher(), "test-token", None)
    monkeypatch.setattr(
        server._thread, "start", Mock(side_effect=RuntimeError("test thread failure"))
    )
    with pytest.raises(RuntimeError, match="test thread failure"):
        server.start()
    server.stop()
    assert server._socket.fileno() == -1
    assert server._executor._shutdown


def test_server_setup_failure_joins_thread_and_closes_resources(monkeypatch):
    async def fail(self):
        raise RuntimeError("test setup failure")

    server = WebServer(Dispatcher(), "test-token", None)
    monkeypatch.setattr(web.AppRunner, "setup", fail)
    with pytest.raises(RuntimeError, match="test setup failure"):
        server.start()
    with pytest.raises(RuntimeError, match="test setup failure"):
        server.stop()
    assert server._socket.fileno() == -1
    assert server._executor._shutdown
    assert not server._thread.is_alive()


@pytest.mark.parametrize("port", [-1, 65536])
def test_out_of_range_port_is_rejected_before_resolution(monkeypatch, port):
    resolving = Mock()
    monkeypatch.setattr(module.socket, "getaddrinfo", resolving)
    with pytest.raises(OverflowError, match="port must be between"):
        WebServer(Dispatcher(), "test-token", None, port)
    resolving.assert_not_called()


def test_wildcard_checks_actual_socket_address_and_forged_host():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.2", 0))
    except OSError as error:
        if error.errno != errno.EADDRNOTAVAIL:
            raise
        pytest.skip(f"Additional loopback address unavailable: {error}")
    server = WebServer(Dispatcher(), "test-token", None, host="0.0.0.0")
    server.start()
    origin = http_origin("127.0.0.2", server.port)
    try:
        with connect(
            f"ws://127.0.0.2:{server.port}/ws?token=test-token",
            origin=origin,
            proxy=None,
        ) as connection:
            connection.send(json.dumps({"id": 1, "method": "ping"}))
            assert json.loads(connection.recv(timeout=5))["result"] == {"pong": None}
        with closing(HTTPConnection("127.0.0.2", server.port, timeout=5)) as connection:
            connection.request("OPTIONS", "/voice", headers={"Origin": origin})
            response = connection.getresponse()
            response.read()
            assert response.status == 204
            assert response.getheader("Access-Control-Allow-Origin") == origin
            connection.request(
                "OPTIONS",
                "/voice",
                headers={"Origin": origin, "Host": f"external.invalid:{server.port}"},
            )
            response = connection.getresponse()
            response.read()
            assert response.status == 403
    finally:
        server.stop()


def test_stop_before_start_releases_listener():
    server = WebServer(Dispatcher(), "test-token", None)
    server.stop()
    server.stop()
    assert server._socket.fileno() == -1
    assert server._executor._shutdown
