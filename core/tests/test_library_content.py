from __future__ import annotations

import json
from contextlib import closing
from http.client import HTTPConnection

import pytest

from fora.adapters.jsonl.protocol import Dispatcher
from fora.adapters.websocket import server as module
from fora.adapters.websocket.server import LIBRARY_MAX_BYTES, WebServer

IMAGE = b"\x89PNG\r\n\x1a\n" + bytes(range(64))


@pytest.fixture
def servers(tmp_path, monkeypatch):
    active = []

    async def collect(_):
        return frozenset({"homebox"})

    monkeypatch.setattr(module, "collect_names", collect)
    library = tmp_path / "library"
    (library / "artifacts").mkdir(parents=True)

    def create():
        server = WebServer(Dispatcher(), "test-token", None, library=library)
        server.start()
        active.append(server)
        return server

    try:
        yield create, library
    finally:
        for server in active:
            server.stop()


def headers_for(server, token="test-token"):
    values = [("Host", f"127.0.0.1:{server.port}")]
    if token is not None:
        values.append(("Authorization", f"Bearer {token}"))
    return values


def request(server, path, headers=(), method="GET"):
    target = "::1" if server.ipv6 else "127.0.0.1"
    with closing(HTTPConnection(target, server.port, timeout=5)) as connection:
        connection.putrequest(method, path, skip_host=True)
        for key, value in headers:
            connection.putheader(key, value)
        connection.endheaders()
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()


def test_serves_the_file_bytes(servers):
    create, library = servers
    server = create()
    (library / "artifacts" / "picture.png").write_bytes(IMAGE)
    status, received, body = request(
        server, "/library/content?path=artifacts/picture.png", headers_for(server)
    )
    assert status == 200
    assert body == IMAGE
    assert received["Content-Type"] == "image/png"
    assert received["Content-Length"] == str(len(IMAGE))
    assert received["Cache-Control"] == "no-store"
    assert received["X-Content-Type-Options"] == "nosniff"
    assert received["Content-Disposition"] == (
        "attachment; filename*=UTF-8''picture.png"
    )


def test_serves_a_requested_byte_range(servers):
    create, library = servers
    server = create()
    (library / "artifacts" / "clip.mp4").write_bytes(bytes(range(256)))
    status, received, body = request(
        server,
        "/library/content?path=artifacts/clip.mp4",
        [*headers_for(server), ("Range", "bytes=4-9")],
    )
    assert status == 206
    assert body == bytes(range(4, 10))
    assert received["Content-Type"] == "video/mp4"
    assert received["Content-Range"] == "bytes 4-9/256"
    assert received["Accept-Ranges"] == "bytes"


def test_refuses_a_file_over_the_preview_limit(servers):
    create, library = servers
    server = create()
    with (library / "artifacts" / "large.mp4").open("wb") as handle:
        handle.truncate(LIBRARY_MAX_BYTES + 1)
    status, _, body = request(
        server, "/library/content?path=artifacts/large.mp4", headers_for(server)
    )
    assert status == 400
    error = json.loads(body)["error"]
    assert error["code"] == "file_too_large"
    assert "20 MB" in error["message"]


def test_serves_a_file_at_the_preview_limit(servers):
    create, library = servers
    server = create()
    with (library / "artifacts" / "limit.mp4").open("wb") as handle:
        handle.truncate(LIBRARY_MAX_BYTES)
    status, received, _ = request(
        server, "/library/content?path=artifacts/limit.mp4", headers_for(server)
    )
    assert status == 200
    assert received["Content-Length"] == str(LIBRARY_MAX_BYTES)


def test_keeps_the_path_inside_the_library(servers, tmp_path):
    create, _ = servers
    server = create()
    (tmp_path / "outside.png").write_bytes(IMAGE)
    for path in (
        "../outside.png",
        f"{tmp_path}/outside.png",
        "artifacts/missing.png",
        "artifacts%00picture.png",
        "",
    ):
        status, _, _ = request(
            server, f"/library/content?path={path}", headers_for(server)
        )
        assert status == 404


def test_authenticates_and_answers_preflight(servers):
    create, _ = servers
    server = create()
    assert (
        request(
            server,
            "/library/content?path=artifacts/picture.png",
            headers_for(server, token=None),
        )[0]
        == 401
    )
    status, received, _ = request(
        server,
        "/library/content",
        [
            ("Host", f"127.0.0.1:{server.port}"),
            ("Origin", f"http://127.0.0.1:{server.port}"),
            ("Access-Control-Request-Method", "GET"),
        ],
        method="OPTIONS",
    )
    assert status == 204
    assert received["Access-Control-Allow-Origin"] == (
        f"http://127.0.0.1:{server.port}"
    )
