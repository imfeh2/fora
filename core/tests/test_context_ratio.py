import asyncio
import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
from pydantic_ai.messages import (
    BinaryContent,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.usage import RunUsage

from fora.adapters.execution.manager import ExecutionManager
from fora.adapters.files.tree import DirectoryTree
from fora.adapters.files.uploads import decode_image
from fora.adapters.model.runner import ContextWindowReached, LiveModel, message_tokens
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.core.context_budget import (
    CONTEXT_WINDOW_FALLBACK,
    IMAGE_TOKENS,
    estimate_text_tokens,
)
from fora.runtime.reminder import TurnOutcome
from fora.runtime.scheduler import Scheduler
from fora.tools import Dependencies


def live(window: int | None, ratio: int, input_tokens: int) -> LiveModel:
    def respond(messages, info):
        return ModelResponse(
            parts=[TextPart("ok")], usage=RunUsage(input_tokens=input_tokens)
        )

    model = FunctionModel(respond)
    return LiveModel(
        lambda: model,
        lambda: "",
        "cache",
        context_ratio_percent=ratio,
        context_window_override=window,
    )


def request(text: str) -> ModelRequest:
    return ModelRequest(parts=[UserPromptPart(text)])


def test_stops_before_the_next_request_when_the_limit_is_reached() -> None:
    model = live(10_000, 50, 6_000)

    assert model.context_limit == 5_000
    asyncio.run(model.request([request("hello")], None, ModelRequestParameters()))

    with pytest.raises(ContextWindowReached):
        asyncio.run(
            model.request(
                [request("hello"), request("again")],
                None,
                ModelRequestParameters(),
            )
        )
    assert model.context_reached is True


def test_unknown_window_falls_back_and_keeps_normal_turns_running() -> None:
    model = live(None, 80, 1_000)

    assert model.window_tokens is None
    assert model.context_limit == CONTEXT_WINDOW_FALLBACK * 80 // 100
    asyncio.run(model.request([request("hello")], None, ModelRequestParameters()))
    asyncio.run(
        model.request(
            [request("hello"), request("again")], None, ModelRequestParameters()
        )
    )

    assert model.context_reached is False


def test_images_count_by_quota_instead_of_bytes() -> None:
    blob = BinaryContent(data=b"x" * 5_000_000, media_type="image/png")
    message = ModelRequest(parts=[UserPromptPart(content=["see", blob])])

    assert message_tokens([message]) == estimate_text_tokens("see") + IMAGE_TOKENS


class ScriptedRunner:
    def __init__(self, *reached: bool) -> None:
        self.script = list(reached)
        self.calls = 0

    def validate_history(self, raw: str) -> None:
        pass

    def check_available(self, agent_id: int) -> None:
        pass

    def live_coverage(self, raw, turn):
        return ()

    def run(self, request, tools):
        self.calls += 1
        reached = self.script.pop(0) if self.script else False
        usage = json.dumps(
            {
                "input_tokens": 10,
                "requests": 1,
                "tool_calls": 0,
                "last_input_tokens": 10,
                "context_window": 1_000,
                "context_limit_reached": reached,
            }
        )
        return TurnOutcome(
            messages_json=request.history_json,
            usage_json=usage,
            input_tokens=10,
            context_limit_reached=reached,
        )


@dataclass
class Fora:
    database: SqliteStore
    settings: SqliteAgentStore
    deps: Dependencies


@pytest.fixture
def fora(tmp_path: Path) -> Iterator[Fora]:
    (tmp_path / "library").mkdir()
    (tmp_path / "agents").mkdir()
    database = SqliteStore(tmp_path / "fora.sqlite3")
    settings = SqliteAgentStore(database._db)

    def agent_directory_for(member_id: int) -> Path:
        path = tmp_path / "agents" / str(member_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    deps = Dependencies(
        store=database,
        history=settings,
        settings=settings,
        execution=ExecutionManager(settings=None, tolerant=True),
        agent_directory_for=agent_directory_for,
        decode_image=decode_image,
        reading=database._db.read,
        library_tree=DirectoryTree(tmp_path / "library"),
        workspace_tree_for=lambda member_id: DirectoryTree(
            tmp_path / "agents" / str(member_id) / "workspace"
        ),
    )
    try:
        yield Fora(database, settings, deps)
    finally:
        deps.execution.close()
        database.close()


def prepare(fora: Fora, *flags: bool) -> tuple[Scheduler, int, int]:
    human = fora.database.create_member("human", "You")
    agent = fora.database.create_member("agent", "Stub")
    discussion = fora.database.create_discussion("Topic", [human.id, agent.id])
    return Scheduler(fora.deps, ScriptedRunner(*flags)), agent.id, discussion.id


def test_early_stop_prepares_the_window_without_a_failure(fora: Fora) -> None:
    scheduler, agent, discussion = prepare(fora, False, True)
    fora.database.append_message(discussion, 1, "@Stub first")
    first = scheduler.run_turn(agent)
    assert first is not None
    assert first.status == "completed"
    assert fora.settings.window(agent).number == 1

    fora.database.append_message(discussion, 1, "@Stub second")
    record = scheduler.run_turn(agent)

    assert record is not None
    assert record.status == "completed"
    assert record.error is None
    window = fora.settings.window(agent)
    assert window.number == 2
    assert window.reason == "prepared"
    run = fora.settings.run_summaries(agent, limit=1)[0]
    assert json.loads(run.usage_json or "{}")["context_limit_reached"] is True


def test_a_second_stop_in_the_new_window_does_not_reset_again(fora: Fora) -> None:
    scheduler, agent, discussion = prepare(fora, False, True, True)
    fora.database.append_message(discussion, 1, "@Stub first")
    first = scheduler.run_turn(agent)
    assert first is not None
    fora.database.append_message(discussion, 1, "@Stub second")
    second = scheduler.run_turn(agent)
    assert second is not None
    assert fora.settings.window(agent).number == 2

    fora.database.append_message(discussion, 1, "@Stub third")
    third = scheduler.run_turn(agent)

    assert third is not None
    assert third.status == "completed"
    assert fora.settings.window(agent).number == 2


def test_a_normal_turn_does_not_reset_the_window(fora: Fora) -> None:
    scheduler, agent, discussion = prepare(fora, False)
    fora.database.append_message(discussion, 1, "@Stub first")

    record = scheduler.run_turn(agent)

    assert record is not None
    assert record.status == "completed"
    window = fora.settings.window(agent)
    assert window.number == 1
    assert window.reason is None
