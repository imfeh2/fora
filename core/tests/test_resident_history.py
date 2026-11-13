import json
from collections.abc import Iterator
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel

from fora.adapters.execution.manager import ExecutionManager
from fora.adapters.files.tree import DirectoryTree
from fora.adapters.files.uploads import decode_image
from fora.adapters.model.blocks import render_block
from fora.adapters.model.runner import PydanticModelRunner
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.core.blocks import WindowContent
from fora.runtime.reminder import TurnRequest
from fora.runtime.scheduler import Scheduler
from fora.tools import Dependencies

AGENTS = "Always sign replies with the team name."
CHANGED = "Never sign replies."

EMPTY = WindowContent()


@pytest.fixture
def settings(tmp_path: Path) -> Iterator[SqliteAgentStore]:
    database = SqliteStore(tmp_path / "fora.sqlite3")
    store = SqliteAgentStore(database._db)
    store.set_settings(
        "model",
        {
            "model": "stub-model",
            "api_type": "openai-chat",
            "base_url": "http://127.0.0.1:1/v1",
            "api_key": "stub",
        },
    )
    try:
        yield store
    finally:
        database.close()


def run_turns(
    settings: SqliteAgentStore,
    instructions: list[str],
    history: WindowContent = EMPTY,
) -> tuple[list[str], WindowContent]:
    sent: list[str] = []

    def respond(messages, info):
        request = next(m for m in reversed(messages) if isinstance(m, ModelRequest))
        sent.append(request.instructions or "")
        return ModelResponse(parts=[TextPart("done")])

    async def stream(messages, info):
        respond(messages, info)
        yield "done"

    @asynccontextmanager
    async def build_model(config):
        yield FunctionModel(respond, stream_function=stream)

    runner = PydanticModelRunner(settings, build_model=build_model)
    for sequence, current in enumerate(instructions, start=1):
        request = TurnRequest(
            agent_id=1,
            sequence=sequence,
            agent_name="Stub",
            prompt=f"reminder {sequence}",
            reminder=None,
            history=history,
            resident="MEMORY",
            environment=lambda: "Commands run on linux",
            ephemeral=lambda: "",
            persist=lambda messages: None,
            instructions=current,
        )
        outcome = runner.run(request, None)
        assert outcome.error is None
        history = outcome.content
    return sent, history


def test_every_turn_sends_the_instructions_read_for_it(
    settings: SqliteAgentStore,
) -> None:
    sent, _ = run_turns(settings, [AGENTS, AGENTS, AGENTS, CHANGED])

    assert len(sent) == 4
    assert all(AGENTS in instructions for instructions in sent[:3])
    assert CHANGED in sent[3] and AGENTS not in sent[3]


def test_a_window_that_lost_its_first_metadata_still_gets_the_instructions(
    settings: SqliteAgentStore,
) -> None:
    _, history = run_turns(settings, [AGENTS, AGENTS])
    first = json.loads(history.message_heads[0])
    first.pop("metadata")
    damaged = WindowContent(
        (json.dumps(first), *history.message_heads[1:]), history.blocks
    )

    sent, _ = run_turns(settings, [AGENTS], damaged)

    assert AGENTS in sent[0]


def test_the_saved_history_has_no_adjacent_requests(
    settings: SqliteAgentStore,
) -> None:
    _, history = run_turns(settings, [AGENTS] * 3)

    kinds = [json.loads(message)["kind"] for message in history.message_heads]
    assert kinds == ["request", "response"] * 3


def test_the_scheduler_reads_the_rules_and_skills_again_every_turn(
    tmp_path: Path,
) -> None:
    library = tmp_path / "library"
    library.mkdir()
    database = SqliteStore(tmp_path / "fora.sqlite3")
    settings = SqliteAgentStore(database._db)
    settings.set_settings(
        "model",
        {
            "model": "stub-model",
            "api_type": "openai-chat",
            "base_url": "http://127.0.0.1:1/v1",
            "api_key": "stub",
        },
    )
    settings.set_settings("agent", {"no_tool_turns_before_pause": 10})
    execution = ExecutionManager()

    def agent_directory_for(member_id: int) -> Path:
        path = tmp_path / "agents" / str(member_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    sent: list[str] = []

    def respond(messages, info):
        request = next(m for m in reversed(messages) if isinstance(m, ModelRequest))
        sent.append(request.instructions or "")
        return ModelResponse(parts=[TextPart("done")])

    @asynccontextmanager
    async def build_model(config):
        yield FunctionModel(respond)

    deps = Dependencies(
        store=database,
        history=settings,
        settings=settings,
        execution=execution,
        agent_directory_for=agent_directory_for,
        decode_image=decode_image,
        render_block=render_block,
        reading=database._db.read,
        library_tree=DirectoryTree(library),
        workspace_tree_for=lambda member_id: DirectoryTree(
            agent_directory_for(member_id) / "workspace"
        ),
    )
    scheduler = Scheduler(deps, PydanticModelRunner(settings, build_model=build_model))
    try:
        human = database.create_member("human", "You")
        agent = database.create_member("agent", "Stub")
        discussion = database.create_discussion("Topic", [human.id, agent.id])
        (library / "AGENTS.md").write_text(AGENTS, encoding="utf-8")
        for turn in range(3):
            database.append_message(discussion.id, human.id, f"@Stub turn {turn}")
            record = scheduler.run_turn(agent.id)
            assert record is not None
            assert record.status == "completed", record
        (library / "AGENTS.md").write_text(CHANGED, encoding="utf-8")
        skill = library / "skills" / "task-flow"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: task-flow\ndescription: Runs a task.\n---\n\nBody.\n",
            encoding="utf-8",
        )
        database.append_message(discussion.id, human.id, "@Stub last turn")
        assert scheduler.run_turn(agent.id) is not None
    finally:
        execution.close()
        database.close()

    assert len(sent) == 4
    assert all(AGENTS in instructions for instructions in sent[:3])
    assert CHANGED in sent[3] and AGENTS not in sent[3]
    assert "- task-flow (library): Runs a task." in sent[3]
