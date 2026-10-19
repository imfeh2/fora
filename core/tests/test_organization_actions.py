from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from pydantic_ai.messages import (
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import FunctionModel

from fora.adapters.execution.manager import ExecutionManager
from fora.adapters.files.tree import DirectoryTree
from fora.adapters.files.uploads import decode_image
from fora.adapters.model.runner import PydanticModelRunner
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.runtime.reminder import TurnRequest
from fora.runtime.scheduler import Scheduler
from fora.tools import AgentTools, Dependencies
from fora.tools.authorize import Actor

HUMAN = 1
MAIN = 2
OTHER = 3


class Settings:
    def get_settings(self, section: str) -> object:
        if section == "model":
            return {
                "api_type": "openai-chat",
                "base_url": "https://example.invalid/v1",
                "api_key": "unused",
                "model": "organization-test",
            }
        return None


@pytest.fixture
def world(tmp_path: Path):
    store = SqliteStore(tmp_path / "fora.sqlite3")
    agent_store = SqliteAgentStore(store._db)
    store.create_member("human", "You")
    store.create_member("agent", "Main")
    store.create_member("agent", "Other")

    def agent_directory_for(member_id: int) -> Path:
        path = tmp_path / "agents" / str(member_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    deps = Dependencies(
        store=store,
        history=agent_store,
        settings=agent_store,
        execution=ExecutionManager(enforce=False),
        agent_directory_for=agent_directory_for,
        decode_image=decode_image,
        library_tree=DirectoryTree(tmp_path / "library"),
        workspace_tree_for=lambda member_id: DirectoryTree(
            tmp_path / "agents" / str(member_id) / "workspace"
        ),
    )
    yield deps
    deps.execution.close()
    store.close()


def _responder(
    action: str, arguments: dict[str, Any], seen: list[Any]
) -> Callable[[Any, Any], ModelResponse]:
    def respond(messages: Any, info: Any) -> ModelResponse:
        del info
        answers = [
            part
            for message in messages
            for part in message.parts
            if isinstance(part, (ToolReturnPart, RetryPromptPart))
            and part.tool_name == "organization"
        ]
        if answers:
            seen.append(answers[-1])
            return ModelResponse(parts=[TextPart("done")])
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "organization",
                    {"action": action, **arguments},
                    tool_call_id="organization",
                )
            ]
        )

    return respond


def _runner(
    action: str, arguments: dict[str, Any], seen: list[Any]
) -> PydanticModelRunner:
    return PydanticModelRunner(
        Settings(),
        build_model=lambda config: FunctionModel(_responder(action, arguments, seen)),
    )


def _turn_request(agent_id: int) -> TurnRequest:
    return TurnRequest(
        agent_id=agent_id,
        sequence=1,
        agent_name="Main",
        prompt="Use the organization tool.",
        reminder=None,
        history_json="[]",
        resident="",
        environment=lambda: "environment",
        ephemeral=lambda: "",
        persist=lambda messages: None,
    )


def call_action(deps: Dependencies, actor_id: int, action: str, **arguments: Any):
    seen: list[Any] = []
    runner = _runner(action, arguments, seen)
    scheduler = Scheduler(deps, runner)
    outcome = runner.run(
        _turn_request(actor_id), scheduler.tools_for_actor(Actor(actor_id, True))
    )
    assert outcome.error is None
    assert len(seen) == 1
    return seen[0]


def returned(part: Any) -> Any:
    assert isinstance(part, ToolReturnPart), part
    return part.content


def rejected(part: Any) -> str:
    assert isinstance(part, RetryPromptPart), part
    assert isinstance(part.content, str), part.content
    return part.content


def mention(
    world: Dependencies, body: str = "@Main Use the organization tool."
) -> None:
    human = AgentTools(world, Actor(HUMAN, False))
    room = human.create_discussion("organization actions", [MAIN])
    human.send_message(room["id"], body)


def run_own_turn(world: Dependencies, action: str, **arguments: Any):
    mention(world)
    seen: list[Any] = []
    runner = _runner(action, arguments, seen)
    scheduler = Scheduler(world, runner)
    record = scheduler.run_turn(MAIN)
    assert record is not None
    assert record.status == "completed", record.error
    assert len(seen) == 1
    return scheduler, seen[0]


def test_rename_action_renames_a_member(world) -> None:
    result = returned(call_action(world, MAIN, "rename", member_id=OTHER, name="Fresh"))
    assert result == {"id": OTHER, "name": "Fresh"}
    member = world.store.get_member(OTHER)
    assert member.name == "Fresh"


def test_rename_action_reports_an_invalid_name(world) -> None:
    message = rejected(
        call_action(world, MAIN, "rename", member_id=OTHER, name="bad@name")
    )
    assert "invalid_name" in message
    member = world.store.get_member(OTHER)
    assert member.name == "Other"


def test_pause_action_pauses_the_agent(world) -> None:
    result = returned(call_action(world, MAIN, "pause", member_id=OTHER))
    assert result["id"] == OTHER
    assert result["state"] == "paused"
    assert result["pause_requested"] is True
    assert world.store.get_member(OTHER).state == "paused"


def test_pause_action_reports_a_missing_member(world) -> None:
    message = rejected(call_action(world, MAIN, "pause", member_id=99))
    assert "not_found" in message


def test_resume_action_resumes_the_agent(world) -> None:
    call_action(world, MAIN, "pause", member_id=OTHER)
    result = returned(call_action(world, MAIN, "resume", member_id=OTHER))
    assert result["state"] == "idle"
    assert world.store.get_member(OTHER).state == "idle"


def test_resume_action_reports_a_missing_member(world) -> None:
    message = rejected(call_action(world, MAIN, "resume", member_id=99))
    assert "not_found" in message


def test_delete_action_deletes_the_agent(world) -> None:
    result = returned(call_action(world, MAIN, "delete", member_id=OTHER))
    assert result == {"id": OTHER, "deleted": True}
    assert world.store.get_member(OTHER).deleted is True


def test_delete_action_reports_a_missing_member(world) -> None:
    message = rejected(call_action(world, MAIN, "delete", member_id=99))
    assert "not_found" in message


def test_pause_action_on_self_waits_for_the_end_of_the_turn(world) -> None:
    scheduler, part = run_own_turn(world, "pause", member_id=MAIN)
    result = returned(part)
    assert result["state"] == "running"
    assert result["pause_requested"] is True
    assert scheduler.agent_status(MAIN)["state"] == "paused"
    assert world.store.get_member(MAIN).state == "paused"


def test_delete_action_on_self_is_rejected_during_the_turn(world) -> None:
    _scheduler, part = run_own_turn(world, "delete", member_id=MAIN)
    message = rejected(part)
    assert "agent_running" in message
    member = world.store.get_member(MAIN)
    assert member is not None
    assert member.deleted is False
