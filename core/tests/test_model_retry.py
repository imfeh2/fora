from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx2
import pytest
import tenacity.wait as wait_module
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.messages import (
    ModelMessagesTypeAdapter,
    ModelResponse,
    TextPart,
    ToolCallPart,
)
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.openai import OpenAIProvider

from fora.adapters.execution.manager import ExecutionManager
from fora.adapters.files.tree import DirectoryTree
from fora.adapters.files.uploads import decode_image
from fora.adapters.model import retry as retry_module
from fora.adapters.model import runner as runner_module
from fora.adapters.model.blocks import from_blocks, render_block
from fora.adapters.model.runner import PydanticModelRunner
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.runtime.reminder import ModelRequestControl
from fora.runtime.scheduler import Scheduler
from fora.tools import AgentTools, Dependencies
from fora.tools.authorize import Actor

REPLY = "@Reader Complete reply."
DISCARDED = "@Reader Discarded reply."


@dataclass
class Clock:
    seconds: float = 0.0

    def advance(self, seconds: float) -> None:
        self.seconds += seconds


@dataclass
class Step:
    result: ModelResponse | Exception | Callable[[], ModelResponse]
    seconds: float = 0.0


@dataclass
class Script:
    clock: Clock
    steps: list[Step] = field(default_factory=list)
    calls: int = 0
    on_wait: Callable[[], None] | None = None

    def respond(self, messages: Any, info: Any) -> ModelResponse:
        self.calls += 1
        step = (
            self.steps.pop(0) if self.steps else Step(ModelResponse([TextPart("done")]))
        )
        self.clock.advance(step.seconds)
        if isinstance(step.result, Exception):
            raise step.result
        return step.result() if callable(step.result) else step.result


def failure(status: int, seconds: float = 0.0) -> Step:
    return Step(
        ModelHTTPError(status, "retry-model", {"message": "provider rejected request"}),
        seconds,
    )


def tool(name: str, arguments: dict[str, Any], call_id: str = "tool") -> ModelResponse:
    return ModelResponse([ToolCallPart(name, arguments, tool_call_id=call_id)])


def reply(room: int, body: str = REPLY) -> Step:
    return Step(
        tool("discussion", {"action": "send", "discussion_id": room, "body": body})
    )


@dataclass
class World:
    store: SqliteStore
    history: SqliteAgentStore
    deps: Dependencies
    scheduler: Scheduler
    script: Script
    clock: Clock
    human: AgentTools
    room: int

    def run(self):
        return self.scheduler.run_turn(2)

    def replies(self) -> list[str]:
        return [
            message.body
            for message in self.store.messages(self.room)
            if message.sender_id == 2
        ]

    def history_text(self) -> str:
        return ModelMessagesTypeAdapter.dump_json(
            from_blocks(self.history.current_content(2))
        ).decode()

    def expect_reply(self, record) -> None:
        assert record.status == "completed", record.error
        assert record.error is None
        assert self.replies() == [REPLY]


@pytest.fixture
def world(tmp_path: Path, monkeypatch) -> Iterator[World]:
    store = SqliteStore(tmp_path / "fora.sqlite3")
    history = SqliteAgentStore(store._db)
    store.create_member("human", "Reader")
    store.create_member("agent", "Writer")
    history.set_settings(
        "model",
        {
            "api_type": "openai-chat",
            "model": "gpt-4o",
            "base_url": "https://provider.example/v1",
            "api_key": "unused",
        },
    )
    execution = ExecutionManager(enforce=False)

    def agent_directory(member_id: int) -> Path:
        directory = tmp_path / "agents" / str(member_id)
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    deps = Dependencies(
        store=store,
        history=history,
        settings=history,
        execution=execution,
        agent_directory_for=agent_directory,
        decode_image=decode_image,
        render_block=render_block,
        reading=store._db.read,
        library_tree=DirectoryTree(tmp_path / "library"),
        workspace_tree_for=lambda member_id: DirectoryTree(
            agent_directory(member_id) / "workspace"
        ),
    )
    clock = Clock()
    script = Script(clock)
    monkeypatch.setattr(
        retry_module, "time", SimpleNamespace(monotonic=lambda: clock.seconds)
    )
    monkeypatch.setattr(
        wait_module, "random", SimpleNamespace(uniform=lambda low, high: high / 2)
    )
    original_wait = ModelRequestControl.wait

    async def wait(control, seconds):
        if script.on_wait is not None:
            callback, script.on_wait = script.on_wait, None
            callback()
            await original_wait(control, seconds)
        else:
            control.check()
            clock.advance(seconds)
            control.check()

    monkeypatch.setattr(ModelRequestControl, "wait", wait)
    runner = PydanticModelRunner(
        history, build_model=lambda config: FunctionModel(script.respond)
    )
    scheduler = Scheduler(deps, runner)
    human = AgentTools(deps, Actor(1, False))
    room = human.create_discussion("Retry acceptance", [2])["id"]
    human.send_message(room, "@Writer Please reply.")
    try:
        yield World(store, history, deps, scheduler, script, clock, human, room)
    finally:
        execution.close()
        store.close()


def test_case_01_two_server_errors_produce_one_complete_reply(world: World) -> None:
    world.script.steps = [failure(500), failure(503), reply(world.room)]
    world.expect_reply(world.run())


@pytest.mark.parametrize("kind", ["rate-limit", "timeout"])
def test_case_02_rate_limit_and_timeout_recover(world: World, kind: str) -> None:
    error = failure(429) if kind == "rate-limit" else Step(TimeoutError())
    world.script.steps = [error, reply(world.room)]
    world.expect_reply(world.run())


def test_case_03_authentication_fails_without_another_request(world: World) -> None:
    world.script.steps = [failure(401), reply(world.room)]
    record = world.run()
    assert record.status == "failed"
    assert "status_code: 401" in record.error
    assert world.script.calls == 1
    assert world.replies() == []
    assert world.clock.seconds == 0


@pytest.mark.parametrize("status", [404, 400], ids=["unknown-model", "invalid-request"])
def test_case_04_invalid_model_and_request_fail_immediately(
    world: World, status: int
) -> None:
    world.script.steps = [failure(status), reply(world.room)]
    record = world.run()
    assert record.status == "failed"
    assert f"status_code: {status}" in record.error
    assert world.script.calls == 1
    assert world.clock.seconds == 0
    assert world.replies() == []


def test_case_05_partial_text_survives_disconnection_without_replay(
    world: World,
) -> None:
    async def stream(messages, info):
        world.script.calls += 1
        yield "Received text."
        raise ConnectionError("connection closed")

    runner = PydanticModelRunner(
        world.history, build_model=lambda config: FunctionModel(stream_function=stream)
    )
    world.scheduler = Scheduler(world.deps, runner)
    record = world.run()
    assert record.status == "failed"
    assert "ConnectionError" in record.error
    messages = ModelMessagesTypeAdapter.validate_json(world.history_text())
    assert [
        part.content
        for message in messages
        if isinstance(message, ModelResponse)
        for part in message.parts
        if isinstance(part, TextPart)
    ] == ["Received text."]
    assert world.script.calls == 1


def test_case_06_continuous_failures_exhaust_ten_minutes_and_can_resume(
    world: World,
) -> None:
    world.script.steps = [failure(503) for _ in range(100)] + [reply(world.room)]
    record = world.run()
    assert record.status == "failed"
    assert world.scheduler.agent_status(2)["state"] == "error"
    assert 599 <= world.clock.seconds <= 600
    assert world.replies() == []
    assert "status_code: 503" in record.error
    assert world.scheduler.resume(2, can_recover=False)["state"] == "idle"


def test_case_07_success_and_two_minute_tool_do_not_consume_retry_budget(
    world: World, monkeypatch
) -> None:
    def run_tool(self, argv, cwd=None, timeout=None):
        world.clock.advance(120)
        return {"exit_code": 0, "stdout": "tool finished", "stderr": ""}

    monkeypatch.setattr(AgentTools, "run", run_tool)
    world.script.steps = [
        failure(503, 400),
        Step(tool("run", {"argv": ["fixture-tool"]}), 160),
        failure(503, 100),
        reply(world.room),
    ]
    world.expect_reply(world.run())


def test_case_08_resuming_starts_a_new_turn_with_a_new_budget(world: World) -> None:
    world.script.steps = [failure(503) for _ in range(100)]
    assert world.run().status == "failed"
    world.scheduler.resume(2, can_recover=False)
    world.human.send_message(world.room, "@Writer Try again.")
    world.script.steps = [failure(503), reply(world.room)]
    world.expect_reply(world.run())


def test_case_09_success_in_the_same_turn_does_not_reset_budget(world: World) -> None:
    world.script.steps = [
        failure(503, 585),
        Step(tool("organization", {"action": "list_members"})),
        *[failure(503) for _ in range(100)],
        reply(world.room),
    ]
    record = world.run()
    assert record.status == "failed"
    assert 599 <= world.clock.seconds <= 600
    assert world.replies() == []


def test_case_10_pause_during_backoff_stops_without_another_attempt(
    world: World,
) -> None:
    world.script.steps = [failure(503), reply(world.room)]
    world.script.on_wait = lambda: world.scheduler.pause(2)
    record = world.run()
    assert record.status == "interrupted"
    assert record.error is None
    assert world.scheduler.agent_status(2)["state"] == "paused"
    assert world.script.calls == 1
    assert world.replies() == []


def test_case_11_pause_during_request_discards_its_result(world: World) -> None:
    def stopped_result():
        world.scheduler.pause(2)
        return reply(world.room, DISCARDED).result

    world.script.steps = [Step(stopped_result)]
    record = world.run()
    assert record.status == "interrupted"
    assert record.error is None
    assert world.scheduler.agent_status(2)["state"] == "paused"
    assert DISCARDED not in world.history_text()
    assert world.replies() == []
    assert world.script.calls == 1


def test_case_12_resume_does_not_replay_the_stopped_result(world: World) -> None:
    def stopped_result():
        world.scheduler.pause(2)
        return reply(world.room, DISCARDED).result

    world.script.steps = [Step(stopped_result)]
    world.run()
    world.scheduler.resume(2, can_recover=False)
    world.script.steps = [reply(world.room)]
    world.expect_reply(world.run())
    assert DISCARDED not in world.history_text()


def test_case_13_retry_does_not_duplicate_tool_side_effect(world: World) -> None:
    world.script.steps = [
        reply(world.room),
        failure(503),
        Step(ModelResponse([TextPart("done")])),
    ]
    world.expect_reply(world.run())


def provider_stream(api_type: str, arguments: dict[str, Any] | None) -> bytes:
    if api_type == "openai-chat":
        delta = (
            {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "send",
                        "type": "function",
                        "function": {
                            "name": "discussion",
                            "arguments": json.dumps(arguments),
                        },
                    }
                ]
            }
            if arguments
            else {"content": "done"}
        )
        events = [
            {
                "id": "response",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "gpt-4o",
                "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
            },
            {
                "id": "response",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "gpt-4o",
                "choices": [
                    {
                        "index": 0,
                        "delta": {},
                        "finish_reason": "tool_calls" if arguments else "stop",
                    }
                ],
            },
        ]
        return (
            "".join(f"data: {json.dumps(event)}\n\n" for event in events)
            + "data: [DONE]\n\n"
        ).encode()
    if api_type == "google":
        part = (
            {"functionCall": {"id": "send", "name": "discussion", "args": arguments}}
            if arguments
            else {"text": "done"}
        )
        event = {
            "candidates": [
                {"content": {"role": "model", "parts": [part]}, "finishReason": "STOP"}
            ],
            "modelVersion": "gemini-2.5-flash",
            "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1},
        }
        return f"data: {json.dumps(event)}\n\n".encode()
    block = (
        {"type": "tool_use", "id": "send", "name": "discussion", "input": {}}
        if arguments
        else {"type": "text", "text": "done"}
    )
    events = [
        {
            "type": "message_start",
            "message": {
                "id": "response",
                "type": "message",
                "role": "assistant",
                "model": "claude-haiku-4-5",
                "content": [],
                "stop_reason": None,
                "usage": {"input_tokens": 1, "output_tokens": 0},
            },
        },
        {"type": "content_block_start", "index": 0, "content_block": block},
    ]
    if arguments:
        events.append(
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": json.dumps(arguments),
                },
            }
        )
    events.extend(
        [
            {"type": "content_block_stop", "index": 0},
            {
                "type": "message_delta",
                "delta": {
                    "stop_reason": "tool_use" if arguments else "end_turn",
                    "stop_sequence": None,
                },
                "usage": {"output_tokens": 1},
            },
            {"type": "message_stop"},
        ]
    )
    return "".join(
        f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events
    ).encode()


@pytest.mark.parametrize("api_type", ["openai-chat", "anthropic", "google"])
def test_case_14_all_providers_recover_with_the_same_reply(
    world: World, monkeypatch, api_type: str
) -> None:
    calls = []

    async def request(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx2.Response(
                503,
                json={
                    "error": {
                        "code": 503,
                        "message": "provider busy",
                        "status": "UNAVAILABLE",
                    }
                },
            )
        arguments = (
            {"action": "send", "discussion_id": world.room, "body": REPLY}
            if len(calls) == 2
            else None
        )
        return httpx2.Response(
            200,
            content=provider_stream(api_type, arguments),
            headers={"content-type": "text/event-stream"},
        )

    providers = {
        "openai-chat": OpenAIProvider,
        "anthropic": AnthropicProvider,
        "google": GoogleProvider,
    }
    names = {
        "openai-chat": "OpenAIProvider",
        "anthropic": "AnthropicProvider",
        "google": "GoogleProvider",
    }

    def provider(**kwargs):
        return providers[api_type](
            http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(request)),
            **kwargs,
        )

    monkeypatch.setattr(runner_module, names[api_type], provider)
    models = {
        "openai-chat": "gpt-4o",
        "anthropic": "claude-haiku-4-5",
        "google": "gemini-2.5-flash",
    }
    world.history.set_settings(
        "model",
        {
            "api_type": api_type,
            "model": models[api_type],
            "base_url": "https://provider.example/v1",
            "api_key": "unused",
        },
    )
    world.scheduler = Scheduler(world.deps, PydanticModelRunner(world.history))
    world.expect_reply(world.run())


def test_case_15_each_retry_has_one_diagnostic_record(world: World, caplog) -> None:
    world.script.steps = [failure(503), failure(503), reply(world.room)]
    world.expect_reply(world.run())
    records = [
        record.getMessage()
        for record in caplog.records
        if record.name == "fora.model"
        and record.getMessage().startswith("Model retry agent=")
    ]
    assert len(records) == 2
    for attempt, message in enumerate(records, 1):
        assert f"retry={attempt} " in message
        assert "wait_seconds=" in message
        assert "last_error=ModelHTTPError status=503" in message
