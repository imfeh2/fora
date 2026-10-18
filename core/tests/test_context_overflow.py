from collections.abc import Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import pytest
from pydantic_ai.exceptions import ModelHTTPError, UnexpectedModelBehavior
from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel

from fora.adapters.execution.manager import ExecutionManager
from fora.adapters.files.tree import DirectoryTree
from fora.adapters.files.uploads import decode_image
from fora.adapters.model.runner import PydanticModelRunner
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.runtime.reminder import TurnOutcome, TurnRequest
from fora.runtime.scheduler import Scheduler
from fora.tools import Dependencies

DEEPSEEK_CONTEXT = (
    "This model's maximum context length is 1048576 tokens. However, you requested"
    " 1048988 tokens (1048988 in the messages, 0 in the completion). Please reduce"
    " the length of the messages or completion."
)

PYDANTIC_TOKEN_LIMIT = (
    "Model token limit (provider default) exceeded before any response was generated."
    " Increase the `max_tokens` model setting, or simplify the prompt to result in a"
    " shorter response that will fit within the limit."
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
    settings.set_settings(
        "model",
        {
            "model": "stub-model",
            "api_type": "openai-chat",
            "base_url": "http://127.0.0.1:1/v1",
            "api_key": "stub",
        },
    )
    execution = ExecutionManager(
        settings=settings.get_settings("execution"), tolerant=True
    )

    def agent_directory_for(member_id: int) -> Path:
        path = tmp_path / "agents" / str(member_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    deps = Dependencies(
        store=database,
        history=settings,
        settings=settings,
        execution=execution,
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
        execution.close()
        database.close()


def http_error(message: str, body: dict | None = None) -> ModelHTTPError:
    return ModelHTTPError(
        status_code=400,
        model_name="stub-model",
        body=body
        if body is not None
        else {
            "message": message,
            "type": "invalid_request_error",
            "param": None,
            "code": "invalid_request_error",
        },
    )


def with_model(fora: Fora, steps: list[Exception | None]) -> PydanticModelRunner:
    remaining = list(steps)

    def respond(messages, info):
        step = remaining.pop(0)
        if step is not None:
            raise step
        return ModelResponse(parts=[TextPart("done")])

    @asynccontextmanager
    async def build_model(config):
        yield FunctionModel(respond)

    return PydanticModelRunner(fora.settings, build_model=build_model)


def rejected_turn(fora: Fora, error: Exception) -> TurnOutcome:
    runner = with_model(fora, [error])
    request = TurnRequest(
        agent_id=1,
        sequence=1,
        agent_name="Stub",
        prompt="hello",
        reminder=None,
        history_json="[]",
        resident="MEMORY",
        environment=lambda: None,
        ephemeral=lambda: "",
        persist=lambda messages: None,
    )
    return runner.run(request, None)


@pytest.mark.parametrize(
    "error",
    [
        http_error(DEEPSEEK_CONTEXT),
        http_error(
            "This model's maximum context length is 128000 tokens. However, your"
            " messages resulted in 130000 tokens.",
            body={
                "message": "This model's maximum context length is 128000 tokens."
                " However, your messages resulted in 130000 tokens.",
                "type": "invalid_request_error",
                "code": "context_length_exceeded",
            },
        ),
        http_error("prompt is too long: 213000 tokens > 200000 maximum"),
        UnexpectedModelBehavior(PYDANTIC_TOKEN_LIMIT),
    ],
    ids=["deepseek", "openai", "anthropic", "pydantic"],
)
def test_rejected_request_marks_the_window_as_exceeded(
    fora: Fora, error: Exception
) -> None:
    outcome = rejected_turn(fora, error)

    assert outcome.error is not None
    assert outcome.context_exceeded is True
    assert outcome.overflow_context is not None


def test_unrelated_rejection_is_not_a_window_overflow(fora: Fora) -> None:
    outcome = rejected_turn(fora, http_error("Incorrect API key provided"))

    assert outcome.error is not None
    assert outcome.context_exceeded is False


@pytest.mark.parametrize(
    "rejection",
    [http_error(DEEPSEEK_CONTEXT), UnexpectedModelBehavior(PYDANTIC_TOKEN_LIMIT)],
    ids=["deepseek", "pydantic"],
)
def test_one_rejection_switches_window_and_clears_the_error(
    fora: Fora, rejection: Exception
) -> None:
    human = fora.database.create_member("human", "You")
    agent = fora.database.create_member("agent", "Stub")
    discussion = fora.database.create_discussion("Topic", [human.id, agent.id])
    scheduler = Scheduler(fora.deps, with_model(fora, [None, rejection, None]))

    fora.database.append_message(discussion.id, human.id, "@Stub first")
    first = scheduler.run_turn(agent.id)
    assert first is not None
    assert first.status == "completed"
    assert fora.settings.window(agent.id).number == 1

    fora.database.append_message(discussion.id, human.id, "@Stub second")
    rejected = scheduler.run_turn(agent.id)
    assert rejected is not None
    assert rejected.status == "failed"

    window = fora.settings.window(agent.id)
    assert window.number == 2
    assert window.reason == "overflow"
    assert window.since_sequence == rejected.sequence + 1
    assert fora.settings.lifecycle(agent.id).error is None

    fora.database.append_message(discussion.id, human.id, "@Stub third")
    following = scheduler.run_turn(agent.id)
    assert following is not None
    assert following.status == "completed"
    assert following.sequence == rejected.sequence + 1

    runs = fora.settings.run_summaries(agent.id, limit=5)
    assert [run.status for run in runs].count("failed") == 1


def test_first_turn_of_a_window_is_intentionally_not_reset_again(
    fora: Fora,
) -> None:
    human = fora.database.create_member("human", "You")
    agent = fora.database.create_member("agent", "Stub")
    discussion = fora.database.create_discussion("Topic", [human.id, agent.id])
    scheduler = Scheduler(fora.deps, with_model(fora, [http_error(DEEPSEEK_CONTEXT)]))

    fora.database.append_message(discussion.id, human.id, "@Stub first")
    rejected = scheduler.run_turn(agent.id)
    assert rejected is not None
    assert rejected.status == "failed"

    window = fora.settings.window(agent.id)
    assert window.number == 1
    assert window.since_sequence == rejected.sequence
    assert window.reason is None
    assert fora.settings.lifecycle(agent.id).error is not None
