from pathlib import Path

from fora.adapters.websocket.server import static_response


def frontend(directory: Path) -> Path:
    (directory / "assets").mkdir(parents=True)
    (directory / "index.html").write_text("<html></html>", encoding="utf-8")
    (directory / "assets" / "app.js").write_text("", encoding="utf-8")
    return directory


def test_client_routes_serve_the_document(tmp_path: Path) -> None:
    directory = frontend(tmp_path / "webui")
    paths = (
        "/",
        "/discussions",
        "/discussions/12",
        "/library",
        "/library/README.md",
        "/library/tasks/界面 说明/README.md",
        "/settings/model",
    )
    for path in paths:
        response = static_response(directory, path)
        assert response.status == 200, path
        assert response.content_type == "text/html", path


def test_static_files_outside_client_routes_are_unchanged(tmp_path: Path) -> None:
    directory = frontend(tmp_path / "webui")
    asset = static_response(directory, "/assets/app.js")
    assert asset.status == 200
    assert asset.content_type == "text/javascript"
    assert static_response(directory, "/README.md").status == 404


def test_client_routes_keep_the_document_gate(tmp_path: Path) -> None:
    directory = frontend(tmp_path / "webui")
    response = static_response(directory, "/library/README.md", document_allowed=False)
    assert response.status == 403
    assert (
        static_response(directory, "/assets/app.js", origin_allowed=False).status == 403
    )
