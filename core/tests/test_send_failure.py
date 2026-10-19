from collections.abc import Iterator
from pathlib import Path

import pytest

from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.core.errors import DomainError


@pytest.fixture
def store(tmp_path: Path) -> Iterator[SqliteStore]:
    database = SqliteStore(tmp_path / "fora.sqlite3")
    SqliteAgentStore(database._db)
    try:
        yield database
    finally:
        database.close()


def test_failed_send_writes_no_message_and_leaves_no_generation_tables(
    store: SqliteStore,
) -> None:
    human = store.create_member("human", "You")
    agent = store.create_member("agent", "Scribe")
    discussion = store.create_discussion("Topic", [human.id, agent.id])
    with pytest.raises(DomainError):
        store.submit_message(discussion.id, agent.id, "No mention here")
    rows = store._db.execute(
        "SELECT COUNT(*) FROM messages WHERE discussion_id = ?", (discussion.id,)
    )
    assert rows[0][0] == 0
    tables = {
        str(item[0])
        for item in store._db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }
    assert "discussion_previews" not in tables
    assert "agent_generation_parts" not in tables
