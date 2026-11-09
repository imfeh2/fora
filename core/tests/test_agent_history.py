import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.services.history import History

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


def stored_rows(store: SqliteAgentStore) -> list[tuple[int, int, str]]:
    return [
        (int(row["position"]), int(row["sequence"]), str(row["content_json"]))
        for row in store._db.execute(
            "SELECT position, sequence, content_json FROM agent_messages"
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
            store.save_history(AGENT, run.sequence, history)
        store.finish_run(AGENT, run.sequence, status="completed", messages=history)

    rows = stored_rows(store)
    assert [content for _, _, content in rows] == history
    assert sum(len(content) for _, _, content in rows) == sum(map(len, history))
    assert store.current_messages(AGENT) == tuple(history)


def test_a_rewritten_tail_keeps_earlier_turns(store: SqliteAgentStore) -> None:
    first = store.start_run(AGENT)
    store.finish_run(
        AGENT,
        first.sequence,
        status="completed",
        messages=[message("a"), message("b"), message("pending")],
    )
    second = store.start_run(AGENT)
    store.save_history(
        AGENT,
        second.sequence,
        [message("a"), message("b"), message("settled"), message("c")],
    )
    store.save_history(
        AGENT,
        second.sequence,
        [message("a"), message("b"), message("settled"), message("d"), message("e")],
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
    store.finish_run(AGENT, first.sequence, status="completed", messages=[message("a")])
    second = store.start_run(AGENT)
    store.save_history(AGENT, second.sequence, [message("a"), message("b")])
    store.finish_run(AGENT, second.sequence, status="failed", messages=[message("a")])

    assert stored_rows(store) == [(0, first.sequence, message("a"))]


def test_each_window_keeps_its_own_messages(store: SqliteAgentStore) -> None:
    first = store.start_run(AGENT)
    store.finish_run(
        AGENT, first.sequence, status="completed", messages=[message("old")]
    )
    window = store.reset_window(AGENT, "prepared")
    second = store.start_run(AGENT)
    store.finish_run(
        AGENT, second.sequence, status="completed", messages=[message("new")]
    )

    assert store.window_messages(AGENT, window.number - 1) == (message("old"),)
    assert store.current_messages(AGENT) == (message("new"),)


def test_a_turn_reads_back_exactly_what_it_wrote(store: SqliteAgentStore) -> None:
    earlier = store.start_run(AGENT)
    store.finish_run(
        AGENT, earlier.sequence, status="completed", messages=[message("earlier")]
    )
    run = store.start_run(AGENT)
    own = [
        message('line one\nline "two"\t\\ 中文，标点 🙂'),
        message("second"),
        message("third " * 50),
    ]
    store.finish_run(
        AGENT,
        run.sequence,
        status="completed",
        messages=[message("earlier"), *own],
    )
    expected = "[" + ",".join(own) + "]"

    for limit in (1, 7, 64, len(expected) + 10):
        pieces = []
        offset = 0
        while True:
            page = store.read_run_slice(AGENT, run.sequence, offset, limit)
            assert page is not None
            assert page.total_length == len(expected)
            pieces.append(page.messages)
            offset = page.offset + len(page.messages)
            if offset >= page.total_length:
                break
        assert "".join(pieces) == expected

    tail = store.read_run_slice(AGENT, run.sequence, None, 20)
    assert tail is not None
    assert tail.messages == expected[-20:]


def test_a_turn_without_messages_reads_as_an_empty_list(
    store: SqliteAgentStore,
) -> None:
    run = store.start_run(AGENT)

    page = store.read_run_slice(AGENT, run.sequence, None, 2048)

    assert page is not None
    assert (page.messages, page.total_length) == ("[]", 2)


def test_search_finds_the_turn_that_wrote_the_text(store: SqliteAgentStore) -> None:
    history: list[str] = []
    sequences = []
    for text in ("alpha", "needle 100%", "omega"):
        run = store.start_run(AGENT)
        history.append(message(text))
        store.finish_run(AGENT, run.sequence, status="completed", messages=history)
        sequences.append(run.sequence)

    assert [run.sequence for run in store.search_runs(AGENT, "needle 100%")] == [
        sequences[1]
    ]
    assert store.search_runs(AGENT, "needle 1000") == ()


def test_search_pages_through_finished_turns(store: SqliteAgentStore) -> None:
    history: list[str] = []
    finished = []
    for index in range(45):
        run = store.start_run(AGENT)
        history.append(message(f"needle {index}"))
        store.finish_run(AGENT, run.sequence, status="completed", messages=history)
        finished.append(run.sequence)
    running = store.start_run(AGENT)
    store.save_history(AGENT, running.sequence, [*history, message("needle now")])
    search = History(store, AGENT)

    pages = []
    offset: int | None = 0
    while offset is not None:
        found, offset = search.search("needle", offset)
        pages.append([run.sequence for run in found])

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


def test_the_previous_history_layout_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "fora.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TABLE agent_runs (agent_id INTEGER, sequence INTEGER,"
            " messages_json TEXT NOT NULL DEFAULT '[]')"
        )
    connection.close()

    with pytest.raises(RuntimeError, match="previous layout"):
        SqliteStore(path)
