from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import psutil
import pytest
from pydantic_ai import ModelMessagesTypeAdapter
from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.usage import RequestUsage

from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.core.errors import DomainError
from fora.ports.live import LiveRequestCoverage
from fora.ports.usage import UsageCache
from fora.runtime.live import LiveSnapshots


@pytest.fixture
def observed_store(tmp_path: Path):
    store = SqliteStore(tmp_path / "live-usage.sqlite3")
    history = SqliteAgentStore(store._db)
    agent = store.create_member("agent", "Live usage")
    run = history.start_run(agent.id)
    snapshots = LiveSnapshots(lambda name, payload: None)
    observer = snapshots.begin(run)
    history._usage.advance(1000)
    yield store, history, agent.id, run, snapshots, observer
    snapshots.close()
    store.close()


def request_value(history, agent_id, run, observer, usage, *, saved=False):
    model = json.dumps({"model": "live-test", "provider": "test"})
    handle = history.start_model_request(
        agent_id, run.sequence, run.run_id, 1, (), "{}", "{}", model, False
    )
    observer.started(handle, "2026-10-11T00:00:01Z", model)
    version = f"response-{handle.ordinal}"
    metadata = {
        "cost_source": "genai-prices",
        "currency": "USD",
        "field_source": "sdk_serialized",
    }
    response = json.dumps(
        [{"kind": "response", "usage": usage, "metadata": {"fora_usage": metadata}}]
    )
    observer.response(
        handle,
        json.dumps(usage),
        (),
        response,
        version,
        json.dumps(metadata),
        "2026-10-11T00:00:02Z",
    )
    if saved:
        history.finish_model_request(agent_id, run.sequence, handle, (response,))
        observer.saved((LiveRequestCoverage(handle, version),))
    return handle, version, metadata


def test_same_observation_contributes_once_across_summary_daily_groups_and_detail(
    observed_store,
):
    store, history, agent, run, snapshots, observer = observed_store
    first, _, _ = request_value(
        history,
        agent,
        run,
        observer,
        {"input_tokens": 10, "output_tokens": 0, "cost": "0.01"},
        saved=True,
    )
    second, _, _ = request_value(
        history,
        agent,
        run,
        observer,
        {"input_tokens": 20, "output_tokens": 2, "cost": "0.02"},
    )
    observation = snapshots.usage_capture()
    result = history._usage.query(
        {"contributions_only": True}, observation=observation, advance=False
    )
    assert result["summary"]["requests"] == "2"
    assert result["summary"]["total_tokens"] == "32"
    assert result["summary"]["estimated_cost"] == "0.03"
    for groups in result["groups"].values():
        assert sum(int(group["total_tokens"]) for group in groups) == 32
    assert sum(int(day["total_tokens"]) for day in result["daily"]) == 32
    assert len(result["records"]) == 2
    saved = next(
        record for record in result["records"] if record["ordinal"] == first.ordinal
    )
    unsaved = next(
        record for record in result["records"] if record["ordinal"] == second.ordinal
    )
    assert saved["saved"] is True
    assert unsaved["saved"] is False
    detail = history._usage.read(unsaved["record_id"], observation=observation)
    assert detail["usage"]["input_tokens"] == 20
    assert detail["saved"] is False
    display = history._usage.display(
        observation, agent_id=agent, sequences=[run.sequence]
    )
    assert display["summary"] == result["summary"]
    assert display["turns"][run.sequence]["total_tokens"] == "32"
    before = store._db._connection.total_changes
    for _ in range(20):
        history._usage.query({}, observation=observation, advance=False)
        history._usage.read(unsaved["record_id"], observation=observation)
    assert store._db._connection.total_changes == before


def test_usage_capture_uses_the_supplied_immutable_turn_and_checks_epoch(
    observed_store,
):
    _, history, agent, run, snapshots, observer = observed_store
    handle, version, _ = request_value(
        history, agent, run, observer, {"input_tokens": 10, "output_tokens": 1}
    )
    captured = snapshots.capture(agent)
    observer.response(
        handle, '{"input_tokens":20,"output_tokens":2}', (), "[]", version + "-next"
    )
    fixed = snapshots.usage_capture(agent, turns=captured)
    current = snapshots.usage_capture(agent)
    assert json.loads(fixed.turns[0].requests[0].usage_json)["input_tokens"] == 10
    assert json.loads(current.turns[0].requests[0].usage_json)["input_tokens"] == 20
    foreign = LiveSnapshots(lambda name, payload: None)
    with pytest.raises(RuntimeError, match="different runtime"):
        foreign.usage_capture(turns=captured)
    foreign.close()


def test_fixed_observation_survives_final_save_and_snapshot_removal(observed_store):
    _, history, agent, run, snapshots, observer = observed_store
    handle, version, metadata = request_value(
        history, agent, run, observer, {"input_tokens": 10, "output_tokens": 1}
    )
    observation = snapshots.usage_capture()
    history.finish_model_request(
        agent,
        run.sequence,
        handle,
        (
            json.dumps(
                [
                    {
                        "kind": "response",
                        "usage": {"input_tokens": 15, "output_tokens": 2},
                        "metadata": {"fora_usage": metadata},
                    }
                ]
            ),
        ),
    )
    observer.saved((LiveRequestCoverage(handle, version),))
    snapshots.finish(agent, run.sequence, None)
    assert snapshots.capture() == ()
    fixed = history._usage.query({}, observation=observation, advance=False)
    current = history._usage.query(
        {}, observation=snapshots.usage_capture(), advance=False
    )
    assert fixed["summary"]["total_tokens"] == "11"
    assert current["summary"]["total_tokens"] == "17"
    assert fixed["summary"]["requests"] == current["summary"]["requests"] == "1"


def test_cache_reuses_only_persistent_aggregates_and_invalidates_database_changes(
    observed_store, monkeypatch
):
    store, history, agent, run, snapshots, observer = observed_store
    handle, version, metadata = request_value(
        history, agent, run, observer, {"input_tokens": 10, "output_tokens": 1}
    )
    cache = UsageCache()
    calls = []
    original = history._usage._aggregates

    def aggregate(execute, table, where, values):
        calls.append(table)
        return original(execute, table, where, values)

    monkeypatch.setattr(history._usage, "_aggregates", aggregate)
    first = history._usage.query(
        {}, observation=snapshots.usage_capture(), cache=cache, advance=False
    )
    observer.response(
        handle,
        '{"input_tokens":20,"output_tokens":2}',
        (),
        "[]",
        version + "-new",
        json.dumps(metadata),
    )
    second = history._usage.query(
        {}, observation=snapshots.usage_capture(), cache=cache, advance=False
    )
    assert first["summary"]["total_tokens"] == "11"
    assert second["summary"]["total_tokens"] == "22"
    assert calls.count("persisted_usage") == 1
    assert calls.count("live_usage") == 2
    with store._db:
        store._db.execute(
            "UPDATE members SET name = ? WHERE id = ?", ("Updated", agent)
        )
    third = history._usage.query(
        {}, observation=snapshots.usage_capture(), cache=cache, advance=False
    )
    assert calls.count("persisted_usage") == 2
    assert third["records"][0]["agent_name"] == "Updated"
    cache.clear()
    history._usage.query(
        {}, observation=snapshots.usage_capture(), cache=cache, advance=False
    )
    assert calls.count("persisted_usage") == 3


def test_live_cursor_binds_epoch_revisions_filters_and_bidirectional_pages(
    observed_store,
):
    _, history, agent, run, snapshots, observer = observed_store
    for index in range(25):
        request_value(
            history,
            agent,
            run,
            observer,
            {"input_tokens": index, "output_tokens": 0},
            saved=index % 2 == 0,
        )
    observation = snapshots.usage_capture()
    first = history._usage.query({"limit": 10}, observation=observation, advance=False)
    second = history._usage.query(
        {"limit": 10, "cursor": first["next_cursor"]},
        observation=observation,
        advance=False,
    )
    previous = history._usage.query(
        {"limit": 10, "cursor": second["previous_cursor"]},
        observation=observation,
        advance=False,
    )
    assert previous["records"] == first["records"]
    assert first["summary"] == second["summary"]
    assert (
        len({record["record_id"] for record in first["records"] + second["records"]})
        == 20
    )
    request_value(
        history, agent, run, observer, {"input_tokens": 100, "output_tokens": 0}
    )
    with pytest.raises(DomainError, match="changed"):
        history._usage.query(
            {"limit": 10, "cursor": first["next_cursor"]},
            observation=snapshots.usage_capture(),
            advance=False,
        )
    with pytest.raises(DomainError, match="another range"):
        history._usage.query(
            {"coverage": "recorded", "cursor": first["next_cursor"]},
            observation=observation,
            advance=False,
        )
    anchor = history._usage.query(
        {"limit": 10, "anchor": first["records"][0]["record_id"]},
        observation=snapshots.usage_capture(),
        advance=False,
    )
    assert anchor["records"] == first["records"]


def test_contribution_qualification_matches_live_and_saved_unknown_zero(observed_store):
    _, history, agent, run, snapshots, observer = observed_store
    request_value(
        history,
        agent,
        run,
        observer,
        {"input_tokens": 0, "output_tokens": 0},
        saved=True,
    )
    request_value(history, agent, run, observer, {"input_tokens": 7})
    model = json.dumps({"model": "pending", "provider": "test"})
    handle = history.start_model_request(
        agent, run.sequence, run.run_id, 1, (), "{}", "{}", model, False
    )
    observer.started(handle, "2026-10-11T00:00:03Z", model)
    observation = snapshots.usage_capture()
    contributions = history._usage.query(
        {"contributions_only": True}, observation=observation, advance=False
    )
    all_records = history._usage.query({}, observation=observation, advance=False)
    assert contributions["summary"]["requests"] == "2"
    assert contributions["summary"]["total_tokens"] == "0"
    assert contributions["summary"]["input_tokens"] == "7"
    assert contributions["summary"]["input_known"] == 2
    assert contributions["summary"]["total_known"] == 1
    assert all_records["summary"]["requests"] == "3"
    assert contributions["coverage"] == {"recorded": 1, "field_missing": 1}
    assert all_records["coverage"]["in_progress"] == 1


@pytest.mark.skipif(sys.platform != "linux", reason="Linux read_chars counters")
@pytest.mark.parametrize("size", [0, 65536, 2097152])
def test_usage_query_display_and_details_have_bounded_body_reads(observed_store, size):
    store, history, agent, run, snapshots, observer = observed_store
    model = '{"model":"bounded-test","provider":"test"}'
    fixed = None
    for index in range(16):
        if index:
            run = history.start_run(agent)
            observer = snapshots.begin(run)
        handle = history.start_model_request(
            agent, run.sequence, run.run_id, 1, (), "{}", "{}", model, False
        )
        response = ModelMessagesTypeAdapter.dump_json(
            [
                ModelResponse(
                    parts=[TextPart(f"{index}:" + "x" * size)],
                    usage=RequestUsage(input_tokens=10, output_tokens=2),
                )
            ]
        ).decode()
        observer.started(handle, "2026-10-11T00:00:01Z", model)
        observer.response(
            handle, '{"input_tokens":10,"output_tokens":2}', (), response, "version"
        )
        history.finish_model_request(agent, run.sequence, handle, (response,))
        observer.saved((LiveRequestCoverage(handle, "version"),))
        if index == 15:
            fixed = snapshots.usage_capture()
        history.finish_run(
            agent,
            run.sequence,
            status="completed",
            messages_json="[]",
            usage_json='{"input_tokens":10,"output_tokens":2,"requests":1}',
        )
        snapshots.finish(agent, run.sequence, None)
    assert fixed is not None
    history._usage.advance(1000)
    database = store._db
    database._connection.execute("ANALYZE")
    with database.read():
        database.execute("SELECT 1")
    connections = [
        database._connection,
        *(reader._connection for reader in database._readers.connections),
    ]
    forbidden = []

    def authorize(action, table, column, database_name, trigger):
        if action == sqlite3.SQLITE_READ and (
            (table == "agent_history_message_blobs" and column == "content_json")
            or (table == "agent_model_requests" and column == "response_json")
            or (table == "agent_runs" and column == "messages_json")
        ):
            forbidden.append((table, column))
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    for connection in connections:
        connection.execute("PRAGMA mmap_size=0")
        connection.execute("PRAGMA cache_size=16")
        connection.set_authorizer(authorize)
    process = psutil.Process()
    wal = store._path.with_name(store._path.name + "-wal")
    before_wal = wal.stat().st_size
    before_changes = database._connection.total_changes
    cache = UsageCache()
    operations = (
        lambda: history._usage.query(
            {"contributions_only": True}, observation=fixed, advance=False
        ),
        lambda: history._usage.query({}, observation=fixed, cache=cache, advance=False),
        lambda: history._usage.query({}, observation=fixed, cache=cache, advance=False),
        lambda: history._usage.display(fixed, agent_id=agent, sequences=[run.sequence]),
        lambda: history._usage.read(f"request:{agent}:1:1", observation=fixed),
        lambda: history._usage.read(
            f"request:{agent}:{run.sequence}:1", observation=fixed
        ),
    )
    try:
        for operation in operations:
            for connection in connections:
                connection.execute("PRAGMA shrink_memory")
            before = process.io_counters().read_chars
            result = operation()
            read_bytes = process.io_counters().read_chars - before
            assert 0 < read_bytes < 512 * 1024, (size, read_bytes)
            if "summary" in result:
                assert result["summary"]["total_tokens"] == "192"
            else:
                assert result["total_tokens"] == "12"
        assert not forbidden
        assert database._connection.total_changes == before_changes
        assert wal.stat().st_size == before_wal
        assert database._readers.borrowed == 0
    finally:
        for connection in connections:
            connection.set_authorizer(None)
        cache.clear()
