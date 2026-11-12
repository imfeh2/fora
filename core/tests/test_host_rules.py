from __future__ import annotations

import http.client
from collections.abc import Iterator
from pathlib import Path

import pytest

from fora.adapters.websocket.server import WebServer


def serve(directory: Path, host: str) -> Iterator[WebServer]:
    (directory / "index.html").write_text("<!doctype html><title>Fora</title>")
    server = WebServer(None, directory, host=host)
    server.start()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def loopback(tmp_path: Path) -> Iterator[WebServer]:
    yield from serve(tmp_path, "127.0.0.1")


@pytest.fixture
def network(tmp_path: Path) -> Iterator[WebServer]:
    yield from serve(tmp_path, "0.0.0.0")


def status(server: WebServer, host: str, origin: str | None = None) -> int:
    connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
    try:
        headers = {"Host": host}
        if origin is not None:
            headers["Origin"] = origin
        connection.request("GET", "/", headers=headers)
        return connection.getresponse().status
    finally:
        connection.close()


@pytest.mark.parametrize("name", ["127.0.0.1", "localhost", "[::1]"])
def test_a_loopback_listener_serves_loopback_names(loopback, name) -> None:
    host = f"{name}:{loopback.port}"
    assert status(loopback, host) == 200
    assert status(loopback, host, f"http://{host}") == 200


@pytest.mark.parametrize("name", ["evil.example", "fora.example.com", "10.0.0.5"])
def test_a_loopback_listener_refuses_other_names(loopback, name) -> None:
    host = f"{name}:{loopback.port}"
    assert status(loopback, host) == 403
    assert status(loopback, host, f"http://{host}") == 403


def test_a_loopback_listener_refuses_other_origins(loopback) -> None:
    host = f"127.0.0.1:{loopback.port}"
    assert status(loopback, host, "http://evil.example") == 403


def test_a_network_listener_serves_any_name(network) -> None:
    host = f"fora.example.com:{network.port}"
    assert status(network, host) == 200
    assert status(network, host, f"http://{host}") == 200
    assert status(network, "fora.example.com", "https://fora.example.com") == 200


def test_a_network_listener_refuses_other_origins(network) -> None:
    host = f"fora.example.com:{network.port}"
    assert status(network, host, "http://evil.example") == 403
