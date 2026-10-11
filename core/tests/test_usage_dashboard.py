from __future__ import annotations

import json
from pathlib import Path

import pytest

from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.core.errors import DomainError


@pytest.fixture
def usage_store(tmp_path: Path):
    store = SqliteStore(tmp_path / "dashboard.sqlite3")
    history = SqliteAgentStore(store._db)
    agent = store.create_member("agent", "Usage test")
    yield store, history, agent.id
    store.close()


def saved_request(history, agent_id, timestamp, usage):
    run = history.start_run(agent_id)
    handle = history.start_model_request(
        agent_id,
        run.sequence,
        "run",
        1,
        (),
        "{}",
        "{}",
        json.dumps({"model": "dashboard-test", "provider": "test"}),
        False,
    )
    with history._db:
        history._db.execute(
            "UPDATE agent_model_requests SET started_at = ? WHERE agent_id = ? AND sequence = ?",
            (timestamp, agent_id, run.sequence),
        )
        history._usage.sync_request(agent_id, run.sequence, handle.ordinal)
    if usage != "pending":
        history.finish_model_request(
            agent_id,
            run.sequence,
            handle,
            (json.dumps([{"kind": "response", "usage": usage}]),),
        )
    return run.sequence, handle


def test_contributions_daily_groups_and_pages_share_one_range(usage_store):
    _, history, agent = usage_store
    for index in range(23):
        saved_request(
            history,
            agent,
            f"2026-10-02T{index:02}:30:00+00:00",
            {"input_tokens": 10, "output_tokens": 2},
        )
    saved_request(history, agent, "2026-10-03T00:30:00+00:00", "pending")
    saved_request(history, agent, "2026-10-03T02:30:00+00:00", None)
    saved_request(history, agent, "2026-10-03T03:30:00+00:00", {"input_tokens": 7})
    result = history.usage_query({"contributions_only": True})
    assert result["filters"]["contributions_only"] is True
    assert len(result["records"]) == 20
    assert result["summary"]["requests"] == "25"
    assert result["summary"]["total_tokens"] == "276"
    assert result["summary"]["input_tokens"] == "237"
    assert result["summary"]["input_known"] == 24
    assert result["summary"]["total_known"] == 23
    assert [day["date"] for day in result["daily"]] == ["2026-10-02", "2026-10-03"]
    for key in ("requests", "input_tokens", "output_tokens", "total_tokens"):
        expected = int(result["summary"][key])
        assert sum(int(day[key] or 0) for day in result["daily"]) == expected
        for groups in result["groups"].values():
            assert sum(int(group[key] or 0) for group in groups) == expected
    second = history.usage_query(
        {
            "contributions_only": True,
            "cursor": result["next_cursor"],
            "dataset_revision": result["dataset_revision"],
        }
    )
    assert len(second["records"]) == 5
    assert second["daily"] == result["daily"]
    assert second["summary"] == result["summary"]
    previous = history.usage_query(
        {
            "contributions_only": True,
            "cursor": second["previous_cursor"],
        }
    )
    assert previous["records"] == result["records"]
    assert all(
        record["coverage"] != "in_progress"
        for record in result["records"] + second["records"]
    )
    with pytest.raises(DomainError, match="another range"):
        history.usage_query({"cursor": result["next_cursor"]})
    assert history.usage_query({})["summary"]["requests"] == "26"


def test_daily_uses_utc_dates_and_partial_boundaries(usage_store):
    _, history, agent = usage_store
    saved_request(
        history,
        agent,
        "2026-10-03T01:00:00+02:00",
        {"input_tokens": 1, "output_tokens": 2},
    )
    saved_request(
        history,
        agent,
        "2026-10-03T00:00:00+00:00",
        {"input_tokens": 3, "output_tokens": 4},
    )
    saved_request(
        history,
        agent,
        "2026-10-03T01:00:00+00:00",
        {"input_tokens": 5, "output_tokens": 6},
    )
    result = history.usage_query(
        {
            "contributions_only": True,
            "start_at": "2026-10-02T23:00:00+00:00",
            "end_at": "2026-10-03T01:00:00+00:00",
        }
    )
    assert [day["date"] for day in result["daily"]] == ["2026-10-02", "2026-10-03"]
    assert [day["total_tokens"] for day in result["daily"]] == ["3", "7"]
    assert result["summary"]["total_tokens"] == "10"
    assert result["summary"]["requests"] == "2"


def test_daily_sparse_legacy_unknown_zero_and_large_values(usage_store):
    _, history, agent = usage_store
    saved_request(
        history,
        agent,
        "0001-01-01T00:00:00+00:00",
        {"input_tokens": 9007199254740993, "output_tokens": 0},
    )
    saved_request(
        history,
        agent,
        "9999-12-31T00:00:00+00:00",
        {"input_tokens": 0, "output_tokens": 0},
    )
    run = history.start_run(agent)
    with history._db:
        history._db.execute(
            "UPDATE agent_runs SET started_at = ? WHERE agent_id = ? AND sequence = ?",
            ("2026-10-04T00:00:00+00:00", agent, run.sequence),
        )
    history.finish_run(
        agent,
        run.sequence,
        status="completed",
        messages_json="[]",
        usage_json='{"input_tokens":7}',
    )
    result = history.usage_query({"contributions_only": True})
    assert len(result["daily"]) == 3
    assert result["daily"][0]["total_tokens"] == "9007199254740993"
    assert result["daily"][1]["requests"] is None
    assert result["daily"][1]["total_tokens"] is None
    assert result["daily"][2]["total_tokens"] == "0"
    unknown = history.usage_query({"contributions_only": True, "model_key": "unknown"})
    assert unknown["summary"]["records"] == 1
    assert unknown["records"][0]["record_id"] == f"turn:{agent}:{run.sequence}"
    empty = history.usage_query({"contributions_only": True, "model_key": "absent"})
    assert empty["daily"] == []
    assert empty["summary"]["requests"] == "0"


@pytest.mark.parametrize("value", [1, "true", None, {}, []])
def test_contributions_only_rejects_non_boolean(usage_store, value):
    _, history, _ = usage_store
    with pytest.raises(DomainError, match="boolean"):
        history.usage_query({"contributions_only": value})


def test_contribution_cursor_revision_recovers_by_anchor(usage_store):
    _, history, agent = usage_store
    for index in range(22):
        saved_request(
            history,
            agent,
            f"2026-10-02T{index:02}:00:00+00:00",
            {"input_tokens": 0, "output_tokens": 0},
        )
    first = history.usage_query({"contributions_only": True})
    saved_request(
        history,
        agent,
        "2026-10-03T00:00:00+00:00",
        {"input_tokens": 1, "output_tokens": 1},
    )
    with pytest.raises(DomainError, match="changed"):
        history.usage_query(
            {"contributions_only": True, "cursor": first["next_cursor"]}
        )
    resumed = history.usage_query(
        {"contributions_only": True, "anchor": first["records"][0]["record_id"]}
    )
    assert resumed["dataset_revision"] > first["dataset_revision"]
    assert resumed["records"] == first["records"]
    assert resumed["summary"]["total_tokens"] == "2"
    assert resumed["daily"][-1]["total_tokens"] == "2"
