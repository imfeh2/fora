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

from fora.adapters.model.blocks import PartKinds, render_block, to_blocks
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.core.blocks import Block, WindowContent
from fora.core.errors import DomainError
from fora.services.history import LIST_LIMIT, READ_LIMIT, History

AGENT = 1


def prompt_blocks(messages):
    kinds = PartKinds()
    for message in messages:
        for part in message.parts:
            if isinstance(part, UserPromptPart):
                kinds.mark(part, "reminder")
    return to_blocks(messages, kinds)


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
        tuple(messages), tuple(Block("reminder", message) for message in messages)
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
        AGENT, run.sequence, status="completed", content=prompt_blocks(messages)
    )
    return run.sequence


def history(store: SqliteAgentStore) -> History:
    return History(store, AGENT, render_block)


def test_a_window_lists_and_reads_its_blocks(store: SqliteAgentStore) -> None:
    earlier = [ModelRequest(parts=[UserPromptPart("earlier")])]
    finish(store, earlier)
    output = "line\n" * 5000
    finish(
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

    listed = history(store).list()
    tool_text = 'run {"argv":["cat"]}\nResult:\n' + output
    assert (listed.window, listed.block_count) == (1, 4)
    assert [(entry.block, entry.kind) for entry in listed.blocks] == [
        (0, "reminder"),
        (1, "text"),
        (2, "tool"),
        (3, "text"),
    ]
    assert listed.blocks[2].length == len(tool_text)
    assert listed.blocks[2].preview.startswith('run {"argv":["cat"]} Result: line')
    assert listed.next_offset is None

    pieces = []
    offset: int | None = 0
    while offset is not None:
        page = history(store).read(2, offset=offset)
        pieces.append(page.text)
        offset = page.next_offset
    assert "".join(pieces) == tool_text
    assert len(pieces) == -(-len(tool_text) // READ_LIMIT)


def test_a_long_window_lists_in_pages(store: SqliteAgentStore) -> None:
    finish(
        store,
        [ModelRequest(parts=[UserPromptPart(f"note {index}")]) for index in range(120)],
    )

    pages = []
    offset: int | None = 0
    while offset is not None:
        listed = history(store).list(offset=offset)
        pages.append([entry.block for entry in listed.blocks])
        offset = listed.next_offset

    assert [len(page) for page in pages] == [LIST_LIMIT, LIST_LIMIT, 20]
    assert [block for page in pages for block in page] == list(range(120))


def test_an_earlier_window_stays_readable(store: SqliteAgentStore) -> None:
    finish(store, [ModelRequest(parts=[UserPromptPart("before the reset")])])
    store.reset_window(AGENT, "prepared")
    finish(store, [ModelRequest(parts=[UserPromptPart("after the reset")])])

    assert history(store).read(0).text == "after the reset"
    assert history(store).read(0, window=1).text == "before the reset"
    assert history(store).list(1).block_count == 1


def test_a_missing_window_or_block_is_not_found(store: SqliteAgentStore) -> None:
    finish(store, [ModelRequest(parts=[UserPromptPart("only")])])

    with pytest.raises(DomainError, match="Window 1 has no block 1"):
        history(store).read(1)
    with pytest.raises(DomainError, match="Window 2 does not exist"):
        history(store).list(2)
    with pytest.raises(DomainError, match="must be a non-negative integer"):
        history(store).read(0, window=-1)


def test_search_finds_the_block_that_holds_the_text(
    store: SqliteAgentStore,
) -> None:
    messages: list = []
    for text in ("alpha", "needle 100%", "omega"):
        messages = [
            *messages,
            ModelRequest(parts=[UserPromptPart(f"reminder {text}")]),
            ModelResponse(parts=[TextPart(f"answer {text}")]),
        ]
        finish(store, messages)
    store.reset_window(AGENT, "prepared")
    finish(store, [ModelRequest(parts=[UserPromptPart("needle again")])])

    found, next_offset = history(store).search("NEEDLE")

    assert [(hit.window, hit.block, hit.kind) for hit in found] == [
        (2, 0, "reminder"),
        (1, 3, "text"),
        (1, 2, "reminder"),
    ]
    assert found[1].snippet == "answer needle 100%"
    assert next_offset is None
    assert history(store).search("needle 1000") == ((), None)


def test_search_pages_and_skips_the_work_in_progress(
    store: SqliteAgentStore,
) -> None:
    messages: list = []
    for index in range(45):
        messages = [*messages, ModelRequest(parts=[UserPromptPart(f"needle {index}")])]
        finish(store, messages)
    running = store.start_run(AGENT)
    store.save_history(
        AGENT,
        running.sequence,
        prompt_blocks([*messages, ModelRequest(parts=[UserPromptPart("needle now")])]),
    )

    pages = []
    offset: int | None = 0
    while offset is not None:
        found, offset = history(store).search("needle", offset)
        pages.append([hit.block for hit in found])

    assert [len(page) for page in pages] == [20, 20, 5]
    assert [block for page in pages for block in page] == list(range(44, -1, -1))


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


def test_the_unused_block_length_is_dropped(tmp_path: Path) -> None:
    path = tmp_path / "fora.sqlite3"
    first = SqliteStore(path)
    SqliteAgentStore(first._db)
    first.close()
    with sqlite3.connect(path) as connection:
        connection.execute(
            "ALTER TABLE agent_blocks ADD COLUMN char_length INTEGER NOT NULL DEFAULT 0"
        )
        connection.execute(
            "CREATE INDEX agent_blocks_run"
            " ON agent_blocks (agent_id, sequence, position, char_length)"
        )
    connection.close()

    database = SqliteStore(path)
    try:
        store = SqliteAgentStore(database._db)
        finish(store, [ModelRequest(parts=[UserPromptPart("kept")])])
        columns = {
            row["name"] for row in store._db.execute("PRAGMA table_info(agent_blocks)")
        }
        indexes = {
            row["name"] for row in store._db.execute("PRAGMA index_list(agent_blocks)")
        }
        assert "char_length" not in columns
        assert "agent_blocks_run" not in indexes
        assert history(store).read(0).text == "kept"
    finally:
        database.close()
