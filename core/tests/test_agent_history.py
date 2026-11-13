import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

from fora.adapters.model.blocks import render_block, to_blocks
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.core.blocks import Block, WindowContent
from fora.core.errors import DomainError
from fora.services.history import READ_LIMIT, History

AGENT = 1


@pytest.fixture
def database(tmp_path: Path) -> Iterator[SqliteStore]:
    database = SqliteStore(tmp_path / "fora.sqlite3")
    try:
        yield database
    finally:
        database.close()


@pytest.fixture
def store(database: SqliteStore) -> SqliteAgentStore:
    return SqliteAgentStore(database._db)


def message(text: str) -> str:
    return json.dumps(
        {"kind": "request", "parts": [{"part_kind": "user-prompt", "content": text}]},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def content_of(messages: list[str]) -> WindowContent:
    return WindowContent(
        tuple(messages), tuple(Block("input", message) for message in messages)
    )


def stored_rows(store: SqliteAgentStore) -> list[tuple[int, int, str]]:
    return [
        (int(row["position"]), int(row["sequence"]), str(row["content_json"]))
        for row in store._db.execute(
            "SELECT position, sequence, content_json FROM agent_blocks"
            " WHERE agent_id = ? ORDER BY window_number, position",
            (AGENT,),
        )
    ]


def test_the_history_grows_linearly(store: SqliteAgentStore) -> None:
    history: list[str] = []
    for turn in range(1, 41):
        run = store.start_run(AGENT)
        for step in range(5):
            history.append(message(f"turn {turn} step {step} " + "x" * 200))
            store.save_history(AGENT, run.sequence, content_of(history))
        store.finish_run(
            AGENT, run.sequence, status="completed", content=content_of(history)
        )

    rows = stored_rows(store)
    assert [content for _, _, content in rows] == history
    assert sum(len(content) for _, _, content in rows) == sum(map(len, history))
    assert store.current_content(AGENT) == content_of(history)


def test_a_rewritten_tail_keeps_earlier_turns(store: SqliteAgentStore) -> None:
    first = store.start_run(AGENT)
    store.finish_run(
        AGENT,
        first.sequence,
        status="completed",
        content=content_of([message("a"), message("b"), message("pending")]),
    )
    second = store.start_run(AGENT)
    store.save_history(
        AGENT,
        second.sequence,
        content_of([message("a"), message("b"), message("settled"), message("c")]),
    )
    store.save_history(
        AGENT,
        second.sequence,
        content_of(
            [message("a"), message("b"), message("settled"), message("d"), message("e")]
        ),
    )

    assert stored_rows(store) == [
        (0, first.sequence, message("a")),
        (1, first.sequence, message("b")),
        (2, first.sequence, message("settled")),
        (3, second.sequence, message("d")),
        (4, second.sequence, message("e")),
    ]


def test_a_failed_turn_falls_back_to_its_saved_start(store: SqliteAgentStore) -> None:
    first = store.start_run(AGENT)
    store.finish_run(
        AGENT, first.sequence, status="completed", content=content_of([message("a")])
    )
    second = store.start_run(AGENT)
    store.save_history(AGENT, second.sequence, content_of([message("a"), message("b")]))
    store.finish_run(
        AGENT, second.sequence, status="failed", content=content_of([message("a")])
    )

    assert stored_rows(store) == [(0, first.sequence, message("a"))]


def test_each_window_keeps_its_own_messages(store: SqliteAgentStore) -> None:
    first = store.start_run(AGENT)
    store.finish_run(
        AGENT, first.sequence, status="completed", content=content_of([message("old")])
    )
    window = store.reset_window(AGENT, "prepared")
    second = store.start_run(AGENT)
    store.finish_run(
        AGENT, second.sequence, status="completed", content=content_of([message("new")])
    )

    assert store.window_content(AGENT, window.number - 1) == content_of(
        [message("old")]
    )
    assert store.current_content(AGENT) == content_of([message("new")])


def finish(store: SqliteAgentStore, messages: list) -> int:
    run = store.start_run(AGENT)
    store.finish_run(
        AGENT, run.sequence, status="completed", content=to_blocks(messages)
    )
    return run.sequence


def history(store: SqliteAgentStore) -> History:
    return History(store, AGENT, render_block)


def test_a_turn_lists_and_reads_its_blocks(store: SqliteAgentStore) -> None:
    earlier = [ModelRequest(parts=[UserPromptPart("earlier")])]
    finish(store, earlier)
    output = "line\n" * 5000
    turn = finish(
        store,
        [
            *earlier,
            ModelResponse(
                parts=[
                    TextPart("checking"),
                    ToolCallPart("run", {"argv": ["cat"]}, tool_call_id="c"),
                ]
            ),
            ModelRequest(parts=[ToolReturnPart("run", output, tool_call_id="c")]),
            ModelResponse(parts=[TextPart("done")]),
        ],
    )

    listed = history(store).list(turn)
    tool_text = 'run {"argv":["cat"]}\nResult:\n' + output
    assert [(entry.index, entry.kind) for entry in listed.blocks] == [
        (0, "text"),
        (1, "tool"),
        (2, "text"),
    ]
    assert listed.blocks[1].length == len(tool_text)
    assert listed.blocks[1].preview.startswith('run {"argv":["cat"]} Result: line')
    assert listed.next_offset is None

    pieces = []
    offset: int | None = 0
    while offset is not None:
        page = history(store).read(turn, 1, offset)
        pieces.append(page.text)
        offset = page.next_offset
    assert "".join(pieces) == tool_text
    assert len(pieces) == -(-len(tool_text) // READ_LIMIT)


def test_a_missing_turn_or_block_is_not_found(store: SqliteAgentStore) -> None:
    turn = finish(store, [ModelRequest(parts=[UserPromptPart("only")])])

    with pytest.raises(DomainError, match="has no block 1"):
        history(store).read(turn, 1)
    with pytest.raises(DomainError, match="does not exist"):
        history(store).list(turn + 1)


def test_search_finds_the_block_that_holds_the_text(
    store: SqliteAgentStore,
) -> None:
    messages: list = []
    turns = []
    for text in ("alpha", "needle 100%", "omega"):
        messages = [
            *messages,
            ModelRequest(parts=[UserPromptPart(f"reminder {text}")]),
            ModelResponse(parts=[TextPart(f"answer {text}")]),
        ]
        turns.append(finish(store, messages))

    found, next_offset = history(store).search("NEEDLE 100%")

    assert [(hit.sequence, hit.index, hit.kind) for hit in found] == [
        (turns[1], 1, "text"),
        (turns[1], 0, "input"),
    ]
    assert found[0].snippet == "answer needle 100%"
    assert next_offset is None
    assert history(store).search("needle 1000") == ((), None)


def test_search_pages_through_finished_turns(store: SqliteAgentStore) -> None:
    messages: list = []
    finished = []
    for index in range(45):
        messages = [*messages, ModelRequest(parts=[UserPromptPart(f"needle {index}")])]
        finished.append(finish(store, messages))
    running = store.start_run(AGENT)
    store.save_history(
        AGENT,
        running.sequence,
        to_blocks([*messages, ModelRequest(parts=[UserPromptPart("needle now")])]),
    )

    pages = []
    offset: int | None = 0
    while offset is not None:
        found, offset = history(store).search("needle", offset)
        pages.append([hit.sequence for hit in found])

    assert [len(page) for page in pages] == [20, 20, 5]
    assert [sequence for page in pages for sequence in page] == finished[::-1]


def test_request_payloads_are_stored_once(store: SqliteAgentStore) -> None:
    run = store.start_run(AGENT)
    for _ in range(3):
        handle = store.start_model_request(
            AGENT, run.sequence, run.window_number, 4, '{"tools":[]}', "{}", "{}", False
        )
        store.finish_model_request(AGENT, run.sequence, handle)
        store.complete_model_request(AGENT, run.sequence, handle)

    payloads = store._db.execute("SELECT COUNT(*) AS n FROM agent_request_payloads")
    statuses = store._db.execute(
        "SELECT status FROM agent_model_requests WHERE agent_id = ?", (AGENT,)
    )
    assert int(payloads[0]["n"]) == 2
    assert [row["status"] for row in statuses] == ["completed"] * 3


@pytest.mark.parametrize(
    "table",
    [
        (
            "CREATE TABLE agent_runs (agent_id INTEGER, sequence INTEGER,"
            " messages_json TEXT NOT NULL DEFAULT '[]')"
        ),
        "CREATE TABLE agent_messages (agent_id INTEGER, content_json TEXT)",
    ],
)
def test_a_previous_history_layout_is_refused(tmp_path: Path, table: str) -> None:
    path = tmp_path / "fora.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute(table)
    connection.close()

    with pytest.raises(RuntimeError, match="previous layout"):
        SqliteStore(path)
