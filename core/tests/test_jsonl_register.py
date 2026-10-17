from __future__ import annotations

import ast
import copy
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from fora.adapters.jsonl.api import Api
from fora.adapters.jsonl.protocol import Dispatcher, Request, Resource

SOURCE = Path(__file__).resolve().parents[1] / "src/fora/adapters/jsonl/api.py"
SNAPSHOT = Path(__file__).with_name("jsonl_register_snapshot.json")
DATA = json.loads(SNAPSHOT.read_text())
METHODS = frozenset(DATA["methods"])
BODIES: dict[str, str] = DATA["bodies"]


class RecordingTools:
    def __init__(self, results: dict[str, Any] | None = None) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.results = dict(results or {})

    def __getattr__(self, name: str) -> Any:
        def call(*args: Any, **kwargs: Any) -> Any:
            self.calls.append((name, args, kwargs))
            return self.results.get(name, {"method": name})

        return call


class StubScheduler:
    def __init__(self, tools: RecordingTools) -> None:
        self.settings = SimpleNamespace()
        self.tools = tools

    def tools_for_actor(self, actor: Any) -> RecordingTools:
        return self.tools

    def wake(self) -> None:
        return None


def _dispatcher(
    tools: RecordingTools | None = None,
) -> tuple[Dispatcher, RecordingTools]:
    active = tools if tools is not None else RecordingTools()
    dispatcher = Dispatcher()
    Api(StubScheduler(active), dispatcher)
    return dispatcher, active


class _Normalize(ast.NodeTransformer):
    def visit_Attribute(self, node: ast.Attribute) -> ast.AST:
        self.generic_visit(node)
        if isinstance(node.value, ast.Name) and node.value.id == "context":
            name = "self" if node.attr == "api" else node.attr
            return ast.copy_location(ast.Name(id=name, ctx=node.ctx), node)
        return node

    def visit_Call(self, node: ast.Call) -> ast.AST:
        self.generic_visit(node)
        if (
            isinstance(node.func, ast.Name)
            and node.func.id in BODIES
            and node.args
            and isinstance(node.args[0], ast.Name)
            and node.args[0].id == "context"
        ):
            node.args = node.args[1:]
        return node


def _body(node: ast.FunctionDef) -> str:
    clone = copy.deepcopy(node)
    if clone.args.args and clone.args.args[0].arg == "context":
        clone.args.args = clone.args.args[1:]
    module = ast.Module(body=clone.body, type_ignores=[])
    return ast.dump(_Normalize().visit(module), include_attributes=False)


def _functions() -> dict[str, list[ast.FunctionDef]]:
    tree = ast.parse(SOURCE.read_text())
    found: dict[str, list[ast.FunctionDef]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in BODIES:
            found.setdefault(node.name, []).append(node)
    return found


def test_method_surface_is_locked() -> None:
    dispatcher, _ = _dispatcher()
    assert set(dispatcher.methods()) == METHODS
    assert set(dispatcher._scopes) == METHODS


def test_library_read_returns_the_tool_result() -> None:
    tools = RecordingTools({"read_library": {"path": "x.txt", "content": "hello"}})
    dispatcher, active = _dispatcher(tools)
    frames: list[dict[str, Any]] = []
    dispatcher.handle(Request(7, "library.read", {"path": "x.txt"}), frames.append)
    assert active.calls == [("read_library", ("x.txt",), {})]
    assert frames == [
        {
            "type": "response",
            "id": 7,
            "result": {"path": "x.txt", "content": "hello"},
        }
    ]


def test_unknown_method_is_reported() -> None:
    dispatcher, _ = _dispatcher()
    frames: list[dict[str, Any]] = []
    dispatcher.handle(Request(9, "nope.nope", {}), frames.append)
    assert frames == [
        {
            "type": "response",
            "id": 9,
            "error": {
                "code": "unknown_method",
                "message": "nope.nope is not a method",
            },
        }
    ]


def test_discussion_send_forwards_the_message() -> None:
    tools = RecordingTools({"send_message": {"id": 4}})
    dispatcher, active = _dispatcher(tools)
    frames: list[dict[str, Any]] = []
    dispatcher.handle(
        Request(3, "discussion.send", {"discussion_id": 5, "body": "hello"}),
        frames.append,
    )
    assert active.calls == [
        (
            "send_message",
            (5, "hello"),
            {
                "mark_read": True,
                "attachment_ids": [],
                "client_message_id": None,
            },
        )
    ]
    assert frames == [{"type": "response", "id": 3, "result": {"id": 4}}]


def test_discussion_send_scope_covers_attachments() -> None:
    dispatcher, _ = _dispatcher()
    request = Request(
        None, "discussion.send", {"discussion_id": 5, "attachment_ids": [1]}
    )
    scope = dispatcher.scope(request)
    assert scope.reads == (
        Resource("member"),
        Resource("attachments", 1),
    )
    assert scope.writes == (Resource("discussion", 5), Resource("attachments", 1))


def test_handler_bodies_are_unchanged() -> None:
    found = _functions()
    assert set(found) == set(BODIES)
    for name, expected in BODIES.items():
        nodes = found[name]
        assert len(nodes) == 1
        assert _body(nodes[0]) == expected
