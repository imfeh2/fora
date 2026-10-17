import json
from collections.abc import Iterator
from pathlib import Path

import pytest

from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore

WINDOW = 2
AGENT = 1
START = "2026-01-01T00:00:00Z"


@pytest.fixture
def store(tmp_path: Path) -> Iterator[SqliteAgentStore]:
    database = SqliteStore(tmp_path / "fora.sqlite3")
    agent = SqliteAgentStore(database._db)
    with database._db:
        database._db.execute(
            "INSERT INTO agent_windows (agent_id, number, since_sequence)"
            " VALUES (?, ?, ?)",
            (AGENT, WINDOW, 10),
        )
    try:
        yield agent
    finally:
        database.close()


def _request(
    store: SqliteAgentStore,
    sequence: int,
    ordinal: int = 1,
    *,
    window: int | None = WINDOW,
    input_messages: tuple[str, ...] = (),
    parameters: dict | None = None,
) -> None:
    with store._db:
        store._db.execute(
            "INSERT INTO agent_model_requests (agent_id, sequence, ordinal, request_id,"
            " run_id, window_number, status, started_at, completed_at, streaming,"
            " messages_json, parameters_json, settings_json, model_json, input_count,"
            " input_length) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, 0, '', ?,"
            " '{}', '{}', ?, 0)",
            (
                AGENT,
                sequence,
                ordinal,
                f"req-{sequence}-{ordinal}",
                f"run-{sequence}",
                window,
                START,
                START,
                json.dumps(parameters or {}),
                len(input_messages),
            ),
        )
        for position, content in enumerate(input_messages):
            digest = f"hash-{sequence}-{ordinal}-{position}"
            store._db.execute(
                "INSERT OR IGNORE INTO agent_history_message_blobs"
                " (content_hash, content_json, byte_length) VALUES (?, ?, ?)",
                (digest, content, len(content)),
            )
            store._db.execute(
                "INSERT INTO agent_model_request_messages"
                " (agent_id, sequence, ordinal, channel, position, content_hash)"
                " VALUES (?, ?, ?, 'input', ?, ?)",
                (AGENT, sequence, ordinal, position, digest),
            )


def test_window_requests_pages_with_exclusive_cursor(
    store: SqliteAgentStore,
) -> None:
    for sequence in range(10, 61):
        _request(store, sequence)

    first = store.window_requests(AGENT, WINDOW, limit=50)
    assert first.total == 51
    assert len(first.requests) == 50
    assert first.has_more is True
    assert first.start_index == 51
    assert first.next_before == (11, 1)

    second = store.window_requests(AGENT, WINDOW, before=first.next_before, limit=50)
    assert second.total == 51
    assert len(second.requests) == 1
    assert second.has_more is False
    assert second.start_index == 1
    assert second.next_before is None


def test_window_request_reports_index_and_total(store: SqliteAgentStore) -> None:
    for sequence in range(10, 61):
        _request(store, sequence)

    found = store.window_request(AGENT, WINDOW, 30, 1)
    assert found is not None
    assert found.index == 21
    assert found.total == 51
    assert found.request.summary.started_at == START

    assert store.window_request(AGENT, 1, 30, 1) is None


def test_window_stats_counts_requests_and_runs(store: SqliteAgentStore) -> None:
    for sequence in range(10, 61):
        _request(store, sequence)
    _request(store, 60, 2)

    stats = store.window_stats(AGENT, WINDOW)
    assert stats is not None
    assert stats.window_number == WINDOW
    assert stats.request_count == 52
    assert stats.run_count == 51
    assert stats.first_started_at == START
    assert stats.last_completed_at == START
    assert stats.since_sequence == 10
    assert stats.is_current is True

    assert store.window_by_number(AGENT, 9) is None
    assert store.window_stats(AGENT, 9) is None


def test_input_sources_reports_both_sources(store: SqliteAgentStore) -> None:
    instructions = {"instruction_parts": [{"content": "SYSTEM A"}]}
    system_message = json.dumps(
        {
            "kind": "request",
            "parts": [{"part_kind": "system-prompt", "content": "SYSTEM B"}],
        }
    )
    _request(store, 10, parameters=instructions, input_messages=(system_message,))
    _request(store, 11, parameters=instructions)
    _request(store, 12, input_messages=(system_message,))
    _request(store, 13)

    both = store.input_sources(AGENT, 10, 1)
    assert [source.kind for source in both] == ["instruction_parts", "system_message"]
    assert both[0].text == "SYSTEM A"
    assert both[1].text == "SYSTEM B"
    assert both[1].message_position == 0

    parts_only = store.input_sources(AGENT, 11, 1)
    assert [source.kind for source in parts_only] == ["instruction_parts"]

    message_only = store.input_sources(AGENT, 12, 1)
    assert [source.kind for source in message_only] == ["system_message"]

    assert store.input_sources(AGENT, 13, 1) == ()
    assert store.input_sources(AGENT, 99, 1) == ()


def test_window_queries_use_the_window_index(store: SqliteAgentStore) -> None:
    plans = [
        (
            (
                "SELECT COUNT(*) FROM agent_model_requests"
                " WHERE agent_id = ? AND window_number = ?"
            ),
            (AGENT, WINDOW),
        ),
        (
            (
                "SELECT ordinal FROM agent_model_requests"
                " WHERE agent_id = ? AND window_number = ?"
                " AND (sequence, ordinal) <= (?, ?)"
            ),
            (AGENT, WINDOW, 0, 0),
        ),
        (
            (
                "SELECT ordinal FROM agent_model_requests"
                " WHERE agent_id = ? AND window_number = ?"
                " AND (sequence, ordinal) < (?, ?)"
                " ORDER BY sequence DESC, ordinal DESC LIMIT ?"
            ),
            (AGENT, WINDOW, 0, 0, 0),
        ),
    ]
    for statement, parameters in plans:
        rows = list(store._db.execute("EXPLAIN QUERY PLAN " + statement, parameters))
        detail = " ".join(str(row["detail"]) for row in rows)
        assert "agent_model_requests_window" in detail


def test_message_paging_caps_at_one_hundred(store: SqliteAgentStore) -> None:
    messages = tuple(
        json.dumps(
            {
                "kind": "request",
                "parts": [{"part_kind": "user-prompt", "content": f"m{index}"}],
            }
        )
        for index in range(101)
    )
    _request(store, 10, input_messages=messages)

    first = store.model_request_messages(AGENT, 10, 1, "input", 0, 100)
    assert first.total == 101
    assert len(first.messages) == 100
    assert first.has_more is True

    second = store.model_request_messages(AGENT, 10, 1, "input", 100, 100)
    assert len(second.messages) == 1
    assert second.has_more is False


def test_empty_input_with_instructions_is_recorded(store: SqliteAgentStore) -> None:
    instructions = {"instruction_parts": [{"content": "SYSTEM"}]}
    _request(store, 10, parameters=instructions)
    _request(store, 11)

    recorded = store.window_request(AGENT, WINDOW, 10, 1)
    assert recorded is not None
    assert recorded.request.summary.input_count == 0
    assert [source.kind for source in store.input_sources(AGENT, 10, 1)] == [
        "instruction_parts"
    ]

    unknown = store.window_request(AGENT, WINDOW, 11, 1)
    assert unknown is not None
    assert unknown.request.summary.input_count == 0
    assert store.input_sources(AGENT, 11, 1) == ()
