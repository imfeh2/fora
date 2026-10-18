import json
from collections.abc import Iterator
from pathlib import Path

import pytest

from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore

AGENT = 1
START = "2026-01-01T00:00:00Z"
WINDOW = 2


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
    input_messages: tuple[str, ...] = (),
) -> None:
    with store._db:
        store._db.execute(
            "INSERT INTO agent_model_requests (agent_id, sequence, ordinal, request_id,"
            " run_id, window_number, status, started_at, completed_at, streaming,"
            " messages_json, parameters_json, settings_json, model_json, input_count,"
            " input_length) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, 0, '', '{}',"
            " '{}', '{}', ?, 0)",
            (
                AGENT,
                sequence,
                ordinal,
                f"req-{sequence}-{ordinal}",
                f"run-{sequence}",
                WINDOW,
                START,
                START,
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
