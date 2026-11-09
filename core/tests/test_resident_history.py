import json
from collections.abc import Iterator
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel

from fora.adapters.model.runner import PydanticModelRunner
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.runtime.reminder import TurnRequest

AGENTS = "Always sign replies with the team name."


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
    settings: SqliteAgentStore, count: int
) -> tuple[list[str], tuple[str, ...]]:
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
    history: tuple[str, ...] = ()
    for sequence in range(1, count + 1):
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
            agents_instructions=AGENTS if not history else None,
        )
        outcome = runner.run(request, None)
        assert outcome.error is None
        history = outcome.messages
    return sent, history


def test_every_turn_of_a_window_keeps_the_agents_instructions(
    settings: SqliteAgentStore,
) -> None:
    sent, history = run_turns(settings, 4)

    assert len(sent) == 4
    assert all(AGENTS in instructions for instructions in sent)
    first = json.loads(history[0])
    assert first["metadata"]["fora"]["block"] == "resident"
    assert first["metadata"]["fora"]["agents_instructions"] == AGENTS


def test_the_saved_history_has_no_adjacent_requests(
    settings: SqliteAgentStore,
) -> None:
    _, history = run_turns(settings, 3)

    kinds = [json.loads(message)["kind"] for message in history]
    assert kinds == ["request", "response"] * 3
