from __future__ import annotations

import json
import sqlite3
from decimal import Decimal
from pathlib import Path

import pytest
from pydantic import ValidationError

from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.adapters.sqlite.usage import UsageIndex
from fora.core.errors import DomainError


@pytest.fixture
def stores(tmp_path: Path):
    store = SqliteStore(tmp_path / "usage.sqlite3")
    history = SqliteAgentStore(store._db)
    agent = store.create_member("agent", "Researcher")
    yield store, history, agent.id
    store.close()


def request(history, agent_id, usage, sequence=None, model=None, metadata=None):
    run = history.start_run(agent_id) if sequence is None else None
    sequence = run.sequence if run is not None else sequence
    handle = history.start_model_request(
        agent_id,
        sequence,
        "run",
        1,
        (),
        "{}",
        "{}",
        json.dumps(model or {"model": "test", "provider": "test"}),
        False,
    )
    if usage != "pending":
        history.finish_model_request(
            agent_id,
            sequence,
            handle,
            (json.dumps([{"kind": "response", "usage": usage, "metadata": metadata}]),),
        )
    return sequence, handle


def test_usage_counts_independent_requests_and_keeps_all_fields(stores):
    _, history, agent_id = stores
    usage = {
        "input_tokens": 100,
        "output_tokens": 20,
        "cache_read_tokens": 30,
        "cache_write_tokens": 10,
        "input_audio_tokens": 20,
        "cache_audio_read_tokens": 5,
        "output_audio_tokens": 4,
        "output_reasoning_tokens": 6,
        "details": {"reasoning_tokens": 6},
        "cost": "0.0000001234567890123456789",
    }
    sequence, handle = request(history, agent_id, usage)
    request(history, agent_id, {"input_tokens": 10, "output_tokens": 0}, sequence)
    history.finish_run(
        agent_id,
        sequence,
        status="failed",
        messages_json="[]",
        usage_json=json.dumps(
            {"input_tokens": 110, "output_tokens": 20, "requests": 2}
        ),
    )
    result = history.usage_query({})
    assert result["summary"]["total_tokens"] == "130"
    assert result["summary"]["requests"] == "2"
    assert result["summary"]["records"] == 2
    record = history.usage_read(f"request:{agent_id}:{sequence}:{handle.ordinal}")
    assert record["usage"] == usage
    assert record["cost"] == usage["cost"]
    assert record["provider_field_presence"] == "unknown"
    assert record["turn_summary"]["requests"] == 2
    assert not record["partial_history"]
    for dimension in result["groups"].values():
        assert sum(int(item["total_tokens"]) for item in dimension) == 130


def test_running_missing_and_zero_remain_distinct(stores):
    _, history, agent_id = stores
    request(history, agent_id, "pending")
    request(history, agent_id, None)
    request(history, agent_id, {"input_tokens": 0, "output_tokens": 0})
    request(history, agent_id, {"input_tokens": 7})
    result = history.usage_query({})
    assert result["coverage"] == {
        "in_progress": 1,
        "missing_usage": 1,
        "recorded": 1,
        "field_missing": 1,
    }
    assert result["summary"]["input_tokens"] == "7"
    assert result["summary"]["total_tokens"] == "0"
    assert result["summary"]["total_known"] == 1
    assert result["summary"]["requests"] == "4"
    for coverage, total in (
        ("recorded", "0"),
        ("missing_usage", None),
        ("in_progress", None),
    ):
        assert (
            history.usage_query({"coverage": coverage})["summary"]["total_tokens"]
            == total
        )


def test_legacy_and_partial_history_contribute_once(stores):
    _, history, agent_id = stores
    run = history.start_run(agent_id)
    history.finish_run(
        agent_id,
        run.sequence,
        status="completed",
        messages_json="[]",
        usage_json=json.dumps(
            {"input_tokens": 200, "output_tokens": 40, "requests": 4}
        ),
    )
    legacy = history.usage_query({})
    assert legacy["summary"]["requests"] == "4"
    assert legacy["summary"]["records"] == 1
    request(history, agent_id, {"input_tokens": 20, "output_tokens": 4}, run.sequence)
    mixed = history.usage_query({})
    assert mixed["summary"]["requests"] == "1"
    assert mixed["summary"]["total_tokens"] == "24"
    assert mixed["records"][0]["partial_history"]
    detail = history.usage_read(mixed["records"][0]["record_id"])
    assert detail["turn_summary"]["input_tokens"] == 200
    assert detail["summary_mismatch"]
    assert history.runs(agent_id)[0].usage_json == json.dumps(
        {"input_tokens": 200, "output_tokens": 40, "requests": 4}
    )
    partial = history.usage_query({"coverage": "partial_history"})
    assert partial["summary"]["total_tokens"] == "24"
    assert partial["summary"]["records"] == 1


def test_legacy_missing_requests_are_unknown(stores):
    _, history, agent_id = stores
    run = history.start_run(agent_id)
    history.finish_run(
        agent_id,
        run.sequence,
        status="completed",
        messages_json="[]",
        usage_json='{"input_tokens":0,"output_tokens":0}',
    )
    result = history.usage_query({})
    assert result["summary"]["requests"] is None
    assert result["summary"]["total_tokens"] == "0"
    assert result["records"][0]["source_kind"] == "turn_summary"


def test_pagination_filters_time_boundaries_and_revision(stores):
    _, history, agent_id = stores
    for _ in range(7):
        request(history, agent_id, {"input_tokens": 10, "output_tokens": 1})
    first = history.usage_query({"limit": 2})
    records = list(first["records"])
    page = first
    while page["has_more"]:
        page = history.usage_query(
            {
                "limit": 2,
                "cursor": page["next_cursor"],
                "dataset_revision": first["dataset_revision"],
            }
        )
        assert page["summary"] == first["summary"]
        records.extend(page["records"])
    assert len({record["record_id"] for record in records}) == 7
    previous = history.usage_query({"limit": 2, "cursor": page["previous_cursor"]})
    assert previous["records"] == records[4:6]
    started = records[3]["started_at"]
    assert history.usage_query({"start_at": started})["summary"]["records"] == 4
    assert history.usage_query({"end_at": started})["summary"]["records"] == 3
    with pytest.raises(DomainError, match="another range"):
        history.usage_query({"agent_id": agent_id, "cursor": first["next_cursor"]})
    request(history, agent_id, {"input_tokens": 1, "output_tokens": 1})
    with pytest.raises(DomainError) as error:
        history.usage_query({"cursor": first["next_cursor"]})
    assert error.value.code == "usage_changed"
    restored = history.usage_query({"anchor": records[3]["record_id"], "limit": 2})
    assert restored["records"][0]["record_id"] == records[3]["record_id"]
    assert restored["summary"]["records"] == 8


def test_deleted_agent_and_model_snapshot_survive_changes(stores):
    store, history, agent_id = stores
    model = {
        "provider_id": "provider-old",
        "registered_model_id": "model-old",
        "display_name": "Original name",
        "model": "remote",
        "api_key": "test-private-value",
    }
    request(history, agent_id, {"input_tokens": 1, "output_tokens": 2}, model=model)
    before = history.usage_query({})
    with store._db:
        store._db.execute(
            "UPDATE members SET deleted = 1, name = 'Renamed' WHERE id = ?", (agent_id,)
        )
    after = history.usage_query({"agent_id": agent_id})
    record = after["records"][0]
    assert record["agent_deleted"]
    assert record["model"]["display_name"] == "Original name"
    assert "api_key" not in record["model"]
    assert record["model_key"] == before["records"][0]["model_key"]
    assert after["dataset_revision"] > before["dataset_revision"]


def test_index_batches_resume_preserve_sources_and_interleaved_writes(stores):
    store, history, agent_id = stores
    for _ in range(5):
        request(history, agent_id, {"input_tokens": 2, "output_tokens": 3})
    pending_sequence, pending = request(history, agent_id, "pending")
    originals = store._db.execute(
        "SELECT content_json FROM agent_history_message_blobs ORDER BY content_hash"
    )
    with store._db:
        store._db.execute("DELETE FROM usage_records")
        store._db.execute(
            "UPDATE usage_index_state SET ready = 0, request_checkpoint = 0, turn_checkpoint = 0"
        )
    index = UsageIndex(store._db)
    assert not index.advance(2)["ready"]
    checkpoint = index.state()["request_checkpoint"]
    restarted = SqliteAgentStore(store._db)
    assert restarted._usage.state()["request_checkpoint"] == checkpoint
    restarted.finish_model_request(
        agent_id,
        pending_sequence,
        pending,
        ('[{"kind":"response","usage":{"input_tokens":9,"output_tokens":1}}]',),
    )
    while not restarted._usage.advance(2)["ready"]:
        pass
    result = restarted.usage_query({})
    assert result["summary"]["total_tokens"] == "35"
    assert result["summary"]["requests"] == "6"
    revision = result["dataset_revision"]
    assert restarted._usage.advance(2)["revision"] == revision
    for row in originals:
        assert store._db.execute(
            "SELECT 1 FROM agent_history_message_blobs WHERE content_json = ?",
            (row["content_json"],),
        )


def test_repeated_response_does_not_add_contribution(stores):
    _, history, agent_id = stores
    sequence, handle = request(
        history, agent_id, {"input_tokens": 3, "output_tokens": 4}
    )
    raw = history.model_request_messages(
        agent_id, sequence, handle.ordinal, "response", 0, 1
    ).messages
    revision = history.usage_query({})["dataset_revision"]
    history.finish_model_request(agent_id, sequence, handle, raw)
    result = history.usage_query({})
    assert result["summary"]["requests"] == "1"
    assert result["summary"]["total_tokens"] == "7"
    assert result["dataset_revision"] == revision


def test_interruption_and_failure_keep_unknown_tokens(stores):
    _, history, agent_id = stores
    sequence, handle = request(history, agent_id, "pending")
    history.fail_model_request(agent_id, sequence, handle, "Disconnected")
    request(history, agent_id, "pending")
    history.mark_interrupted()
    result = history.usage_query({})
    assert result["coverage"] == {"no_response": 2}
    assert result["summary"]["total_tokens"] is None
    assert result["summary"]["requests"] == "2"


def test_invalid_historical_response_preserves_checkpoint(stores):
    store, history, agent_id = stores
    sequence, handle = request(history, agent_id, "pending")
    with store._db:
        store._db.execute(
            "UPDATE agent_model_requests SET response_json = '{invalid' WHERE agent_id = ?",
            (agent_id,),
        )
        store._db.execute("DELETE FROM usage_records")
    with pytest.raises(
        DomainError, match=f"Request {agent_id}/{sequence}/{handle.ordinal}"
    ):
        history._usage.advance(1)
    assert history._usage.state()["error"] is not None
    assert history._usage.state()["request_checkpoint"] == 0
    assert history._usage.state()["ready"] == 0
    assert (
        history.model_request_summary(agent_id, sequence, handle.ordinal).status
        == "pending"
    )
    with store._db:
        store._db.execute(
            "UPDATE agent_model_requests SET response_json = NULL WHERE agent_id = ?",
            (agent_id,),
        )
    while not history._usage.advance(1)["ready"]:
        pass
    assert history._usage.state()["error"] is None


def test_exact_decimal_and_cache_aggregates_preserve_known_range(stores):
    _, history, agent_id = stores
    costs = [
        "0.0000001234567890123456789012345678901",
        "0.0000000000000000000000000000000000002",
        "0",
    ]
    for cost in costs:
        request(
            history,
            agent_id,
            {
                "input_tokens": 100,
                "output_tokens": 5,
                "cache_read_tokens": 25,
                "cache_write_tokens": 10,
                "cost": cost,
            },
            metadata={"fora_usage": {"cost_source": "genai-prices", "currency": "USD"}},
        )
    request(history, agent_id, {"input_tokens": 1, "output_tokens": 0, "cost": "99"})
    request(history, agent_id, None)
    result = history.usage_query({})
    summary = result["summary"]
    assert summary["cache_read_tokens"] == "75"
    assert summary["cache_write_tokens"] == "30"
    assert summary["cache_read_known"] == summary["cache_write_known"] == 3
    assert summary["cost_known"] == 3
    assert Decimal(summary["estimated_cost"]) == Decimal(
        "0.0000001234567890123456789012345678903"
    )
    for dimension in result["groups"].values():
        assert dimension[0]["estimated_cost"] == summary["estimated_cost"]
        assert dimension[0]["cache_read_tokens"] == summary["cache_read_tokens"]
    assert (
        history.usage_query({"coverage": "missing_usage"})["summary"]["estimated_cost"]
        is None
    )


@pytest.mark.parametrize(
    "params",
    [
        {"limit": True},
        {"agent_id": True},
        {"coverage": "unknown"},
        {"model_key": 1},
        {"anchor": 1},
        {"dataset_revision": True},
        {"cursor": 1},
        {"start_at": "2026-10-02T00:00:00"},
    ],
)
def test_query_rejects_invalid_parameters(stores, params):
    _, history, _ = stores
    with pytest.raises(DomainError) as error:
        history.usage_query(params)
    assert error.value.code == "invalid_params"


@pytest.mark.parametrize("cursor", ["{}", "[]", "null", "invalid"])
def test_query_rejects_invalid_cursor_shape(stores, cursor):
    _, history, _ = stores
    with pytest.raises(ValidationError):
        history.usage_query({"cursor": cursor})


def test_same_timestamp_pagination_and_actual_query_indexes(stores):
    store, history, agent_id = stores
    for _ in range(7):
        request(history, agent_id, {"input_tokens": 2, "output_tokens": 3})
    with store._db:
        store._db.execute(
            "UPDATE agent_model_requests SET started_at = '2026-10-02T00:00:00+00:00'"
        )
        for row in store._db.execute(
            "SELECT sequence, ordinal FROM agent_model_requests"
        ):
            history._usage.sync_request(agent_id, row["sequence"], row["ordinal"])
    first = history.usage_query({"limit": 2})
    identities = [record["record_id"] for record in first["records"]]
    page = first
    while page["has_more"]:
        page = history.usage_query({"limit": 2, "cursor": page["next_cursor"]})
        identities.extend(record["record_id"] for record in page["records"])
    assert len(identities) == len(set(identities)) == 7
    assert identities == sorted(identities, reverse=True)
    assert (
        history.usage_query({"start_at": "2026-10-02T00:00:00Z"})["summary"]["records"]
        == 7
    )
    assert (
        history.usage_query({"end_at": "2026-10-02T00:00:00Z"})["summary"]["records"]
        == 0
    )
    model_key = first["records"][0]["model_key"]
    for column, value, index in (
        ("agent_id", agent_id, "usage_agent"),
        ("model_key", model_key, "usage_model"),
        ("coverage", "recorded", "usage_coverage"),
    ):
        plan = store._db.execute(
            "EXPLAIN QUERY PLAN "
            + history._usage._select()
            + f" WHERE u.{column} = ? ORDER BY u.started_at DESC, u.record_id DESC LIMIT 20",
            (value,),
        )
        assert any(index in row["detail"] for row in plan)


def test_completed_request_keeps_index_and_duplicate_response_identity(stores):
    _, history, agent_id = stores
    usage = {"input_tokens": 12, "output_tokens": 3}
    sequence, handle = request(history, agent_id, usage)
    record_id = f"request:{agent_id}:{sequence}:{handle.ordinal}"
    before = history.usage_query({})
    assert history.usage_read(record_id)["status"] == "responded"
    history.complete_model_request(agent_id, sequence, handle)
    completed = history.usage_query({})
    assert completed["dataset_revision"] > before["dataset_revision"]
    assert completed["summary"] == before["summary"]
    assert history.usage_read(record_id)["status"] == "completed"
    history.complete_model_request(agent_id, sequence, handle)
    assert history.usage_query({})["dataset_revision"] == completed["dataset_revision"]
    history.finish_model_request(
        agent_id,
        sequence,
        handle,
        (json.dumps([{"kind": "response", "usage": usage, "metadata": None}]),),
    )
    assert history.usage_query({})["dataset_revision"] == completed["dataset_revision"]
    assert history.usage_read(record_id)["status"] == "completed"
    with pytest.raises(DomainError) as error:
        history.finish_model_request(
            agent_id,
            sequence,
            handle,
            (json.dumps([{"kind": "response", "usage": {"input_tokens": 99}}]),),
        )
    assert error.value.code == "usage_conflict"
    assert history.usage_query({})["dataset_revision"] == completed["dataset_revision"]
    assert history.usage_read(record_id)["usage"] == usage


def test_completed_request_index_update_rolls_back_with_history(stores):
    _, history, agent_id = stores
    sequence, handle = request(
        history, agent_id, {"input_tokens": 2, "output_tokens": 1}
    )
    record_id = f"request:{agent_id}:{sequence}:{handle.ordinal}"
    before = history.usage_query({})
    with pytest.raises(RuntimeError), history.transaction():
        history.complete_model_request(agent_id, sequence, handle)
        assert history.usage_read(record_id)["status"] == "completed"
        raise RuntimeError("rollback")
    summary = history.model_request_summary(agent_id, sequence, handle.ordinal)
    assert summary is not None and summary.status == "responded"
    assert history.usage_read(record_id)["status"] == "responded"
    assert history.usage_query({})["dataset_revision"] == before["dataset_revision"]


def seed_history(db, agent_id, count, *, legacy=False):
    with db:
        for sequence in range(1, count + 1):
            db.execute(
                "INSERT INTO agent_runs(agent_id, sequence, run_id, status, started_at, messages_json, usage_json)"
                " VALUES (?, ?, ?, 'completed', '2026-10-13T00:00:00Z', ?, ?)",
                (
                    agent_id,
                    sequence,
                    str(sequence),
                    json.dumps([{"parts": "x" * 4096}]),
                    '{"requests":1,"input_tokens":2,"output_tokens":3}',
                ),
            )
            if not legacy:
                db.execute(
                    "INSERT INTO agent_model_requests(agent_id, sequence, ordinal, request_id, run_id,"
                    " window_number, status, started_at, streaming, parameters_json, settings_json, model_json, response_json)"
                    " VALUES (?, ?, 1, ?, ?, 1, 'completed', '2026-10-13T00:00:00Z', 0, '{}', '{}', '{}', ?)",
                    (
                        agent_id,
                        sequence,
                        str(sequence),
                        str(sequence),
                        '[{"kind":"response","usage":{"input_tokens":2,"output_tokens":3}}]',
                    ),
                )


def test_initialization_batches_skip_aggregation_and_finish_with_one_query(
    stores, monkeypatch
):
    store, history, agent = stores
    seed_history(store._db, agent, 205)
    original = store._db.execute
    statements = []

    def execute(sql, params=()):
        statements.append(sql)
        return original(sql, params)

    monkeypatch.setattr(store._db, "execute", execute)
    first = history.usage_query({"contributions_only": True})
    assert set(first) == {"status", "filters", "index"}
    assert first["status"] == "initializing"
    assert first["index"]["processed_requests"] == 100
    assert first["index"]["processed_turns"] == 100
    assert not any("usage_decimal_sum" in sql for sql in statements)
    other = SqliteAgentStore(store._db)
    second = other.usage_query({"initialization_version": first["index"]["version"]})
    assert second["status"] == "initializing"
    assert second["index"]["processed_requests"] == 200
    final = history.usage_query({"initialization_version": first["index"]["version"]})
    assert final["status"] == "ready"
    assert final["summary"]["requests"] == "205"
    assert final["summary"]["total_tokens"] == "1025"
    assert final["index"]["processed_turns"] == 205
    assert len(final["records"]) == 20
    repeated = history.usage_query({"dataset_revision": final["dataset_revision"]})
    assert repeated["index"] == final["index"]
    assert repeated["summary"] == final["summary"]


def test_progress_migration_counts_rowid_gaps_once_and_keeps_ready_index(
    stores, monkeypatch
):
    store, history, agent = stores
    seed_history(store._db, agent, 5, legacy=True)
    with store._db:
        store._db.execute("DELETE FROM agent_runs WHERE sequence = 2")
    history._usage.advance(2)
    with store._db:
        store._db.execute(
            "ALTER TABLE usage_index_state DROP COLUMN processed_requests"
        )
        store._db.execute("ALTER TABLE usage_index_state DROP COLUMN processed_turns")
    original = store._db.execute
    plans = []

    def execute(sql, params=()):
        if "COUNT(*) FROM agent_runs INDEXED BY" in sql:
            plans.extend(original("EXPLAIN QUERY PLAN " + sql, params))
        return original(sql, params)

    monkeypatch.setattr(store._db, "execute", execute)
    index = UsageIndex(store._db)
    assert index.state()["processed_turns"] == 2
    state = index.advance(1)
    assert state["turn_checkpoint"] == 4
    assert state["processed_turns"] == 3
    assert state["processed_requests"] == 0
    assert any("COVERING INDEX agent_runs_summary" in row["detail"] for row in plans)
    plan_count = len(plans)
    while not index.advance(1)["ready"]:
        pass
    assert len(plans) == plan_count
    assert index.state()["processed_turns"] == 4
    snapshot = index.query({})
    with store._db:
        store._db.execute(
            "ALTER TABLE usage_index_state DROP COLUMN processed_requests"
        )
        store._db.execute("ALTER TABLE usage_index_state DROP COLUMN processed_turns")
    ready = UsageIndex(store._db)
    monkeypatch.setattr(
        ready, "sync_turn", lambda *args: pytest.fail("Ready index rescanned history")
    )
    result = ready.query({})
    assert result["summary"] == snapshot["summary"]
    assert result["dataset_revision"] == snapshot["dataset_revision"]
    assert result["index"]["processed_turns"] == 4
    assert result["index"]["ready"] == 1


def test_progress_and_records_roll_back_together_and_resume_after_reopen(stores):
    store, history, agent = stores
    seed_history(store._db, agent, 102)
    first = history.usage_query({})
    with store._db:
        store._db.execute(
            "UPDATE agent_model_requests SET response_json = '{invalid' WHERE sequence = 102"
        )
    with pytest.raises(DomainError, match="Request"):
        history.usage_query({"initialization_version": first["index"]["version"]})
    failed = history._usage.state()
    assert failed["request_checkpoint"] == 100
    assert failed["processed_requests"] == 100
    assert failed["processed_turns"] == 100
    assert failed["error"]
    assert not store._db.execute("SELECT 1 FROM usage_records WHERE sequence > 100")
    with store._db:
        store._db.execute(
            "UPDATE agent_model_requests SET response_json = ? WHERE sequence = 102",
            ('[{"kind":"response","usage":{"input_tokens":2,"output_tokens":3}}]',),
        )
    reopened = SqliteStore(store._path)
    try:
        resumed = SqliteAgentStore(reopened._db).usage_query(
            {"initialization_version": first["index"]["version"]}
        )
        assert resumed["status"] == "ready"
        assert resumed["index"]["processed_requests"] == 102
        assert resumed["index"]["processed_turns"] == 102
        assert resumed["index"]["error"] is None
        assert resumed["summary"]["total_tokens"] == "510"
    finally:
        reopened.close()


@pytest.mark.parametrize(
    "params, code",
    [
        ({"initialization_version": True}, "invalid_params"),
        ({"initialization_version": None}, "invalid_params"),
        ({"initialization_version": "1"}, "invalid_params"),
        ({"initialization_version": 1, "dataset_revision": 0}, "invalid_params"),
        ({"initialization_version": 1, "cursor": "invalid"}, "invalid_params"),
        ({"initialization_version": 2}, "usage_changed"),
        ({"cursor": 1}, "invalid_params"),
    ],
)
def test_invalid_initialization_identity_does_not_advance(stores, params, code):
    store, history, agent = stores
    seed_history(store._db, agent, 3)
    before = history._usage.state()
    with pytest.raises(DomainError) as error:
        history.usage_query(params)
    assert error.value.code == code
    assert history._usage.state() == before
    assert not store._db.execute("SELECT 1 FROM usage_records")


@pytest.mark.parametrize("legacy", [False, True])
def test_response_projection_preserves_numeric_cost_and_extra_fields(
    stores, legacy, monkeypatch
):
    store, history, agent = stores
    sequence, handle = request(history, agent, "pending")
    amount = "0.12345678901234567890123456789"
    response = (
        '[{"kind":"response","parts":[{"content":"'
        + "x" * 262144
        + '"}],"usage":{"input_tokens":2,"output_tokens":3,"cost":'
        + amount
        + ',"extra":{"price":1.2345678901234567890123456789}},'
        '"metadata":{"fora_usage":{"cost_source":"genai-prices","currency":"USD"}}}]'
    )
    original_loads = json.loads
    decoded_bytes = []

    def loads(value, *args, **kwargs):
        decoded_bytes.append(len(value))
        return original_loads(value, *args, **kwargs)

    monkeypatch.setattr(json, "loads", loads)
    if legacy:
        with store._db:
            store._db.execute(
                "UPDATE agent_model_requests SET response_json = ?, status = 'responded' WHERE agent_id = ?",
                (response, agent),
            )
            history._usage.sync_request(agent, sequence, handle.ordinal)
    else:
        history.finish_model_request(agent, sequence, handle, (response,))
    detail = history.usage_read(f"request:{agent}:{sequence}:{handle.ordinal}")
    assert detail["cost"] == amount
    assert detail["usage"]["cost"] == amount
    assert detail["usage"]["extra"]["price"] == "1.2345678901234567890123456789"
    assert max(decoded_bytes) < 4096
    assert history.usage_query({})["summary"]["estimated_cost"] == amount


@pytest.mark.parametrize(
    "response",
    [
        "{}",
        "null",
        "[1]",
        '[{"kind":"request"}]',
        '[{"kind":"response","usage":[]}]',
        '[{"kind":"response","metadata":[]}]',
        '[{"kind":"response","metadata":{"fora_usage":"invalid"}}]',
        '[{"kind":"response"},{"kind":"response"}]',
        '[{kind:"response"}]',
        "{invalid",
    ],
)
def test_response_projection_rejects_invalid_sources(stores, response):
    _, history, agent = stores
    sequence, handle = request(history, agent, "pending")
    with pytest.raises(DomainError, match=f"{agent}/{sequence}/{handle.ordinal}"):
        history.finish_model_request(agent, sequence, handle, (response,))
    assert (
        history.model_request_summary(agent, sequence, handle.ordinal).status
        == "pending"
    )


def test_response_projection_keeps_blob_precedence_and_empty_blob_legacy_rule(stores):
    store, history, agent = stores
    sequence, handle = request(history, agent, {"input_tokens": 2, "output_tokens": 3})
    with store._db:
        store._db.execute(
            "UPDATE agent_model_requests SET response_json = '{invalid' WHERE agent_id = ?",
            (agent,),
        )
        history._usage.sync_request(agent, sequence, handle.ordinal)
    assert history.usage_query({})["summary"]["total_tokens"] == "5"
    with store._db:
        store._db.execute(
            "DELETE FROM agent_model_request_messages WHERE channel = 'response'"
        )
        store._db.execute(
            "UPDATE agent_model_requests SET response_json = ? WHERE agent_id = ?",
            (
                '[{"kind":"response","usage":{"input_tokens":7,"output_tokens":8}}]',
                agent,
            ),
        )
        history._store_message_refs(
            agent, sequence, handle.ordinal, "response", (("empty", "[]", 2),)
        )
        history._usage.sync_request(agent, sequence, handle.ordinal)
    assert history.usage_query({})["summary"]["total_tokens"] == "15"


def test_initialization_version_change_and_repeated_sync_preserve_counts(stores):
    store, history, agent = stores
    seed_history(store._db, agent, 101)
    initial = history.usage_query({})
    with store._db:
        store._db.execute("UPDATE usage_index_state SET version = version + 1")
        history._usage.sync_request(agent, 1, 1)
        history._usage.sync_turn(agent, 1)
    assert history._usage.state()["processed_requests"] == 100
    with pytest.raises(DomainError) as error:
        history.usage_query({"initialization_version": initial["index"]["version"]})
    assert error.value.code == "usage_changed"
    assert history._usage.state()["processed_requests"] == 100
    final = history.usage_query({})
    assert final["status"] == "ready"
    assert final["index"]["version"] == 2
    assert final["index"]["processed_requests"] == 101
    with store._db:
        history._usage.sync_request(agent, 101, 1)
    assert history.usage_query({})["index"] == final["index"]


def test_actual_usage_api_reads_turn_summaries_from_covering_index(stores, monkeypatch):
    store, history, agent = stores
    seed_history(store._db, agent, 3, legacy=True)
    original = store._db.execute
    plans = []

    def execute(sql, params=()):
        if (
            sql.startswith(("SELECT", "WITH"))
            and "agent_runs" in sql
            and "INDEXED BY" in sql
        ):
            plans.append(original("EXPLAIN QUERY PLAN " + sql, params))
        rows = original(sql, params)
        if sql.startswith("SELECT"):
            assert all(
                len(value) < 4096
                for row in rows
                for value in row
                if isinstance(value, str)
            )
        return rows

    monkeypatch.setattr(store._db, "execute", execute)
    result = history.usage_query({})
    history.usage_read(result["records"][0]["record_id"])
    history.usage_query({"coverage": "partial_history"})
    assert len(plans) >= 5
    assert all(
        any("COVERING INDEX agent_runs_summary" in row["detail"] for row in plan)
        for plan in plans
    )


def test_initialization_version_is_checked_inside_the_batch(stores, monkeypatch):
    store, history, agent = stores
    seed_history(store._db, agent, 2)
    original = history._usage.advance

    def advance(*args, **kwargs):
        with store._db:
            store._db.execute("UPDATE usage_index_state SET version = 2")
        return original(*args, **kwargs)

    monkeypatch.setattr(history._usage, "advance", advance)
    with pytest.raises(DomainError) as error:
        history.usage_query({"initialization_version": 1})
    assert error.value.code == "usage_changed"
    assert history._usage.state()["processed_requests"] == 0
    assert history._usage.state()["error"] is None
    assert not store._db.execute("SELECT 1 FROM usage_records")


def test_response_projection_propagates_database_failures(stores, monkeypatch):
    store, history, agent = stores

    def broken(sql, params=()):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(store._db, "execute", broken)
    with pytest.raises(sqlite3.OperationalError, match="database is locked"):
        history._usage._response(agent, 1, 1)
