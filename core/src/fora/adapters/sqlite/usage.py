from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from decimal import MAX_PREC, Decimal, localcontext
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from fora.adapters.sqlite.store import LockedConnection, first
from fora.core.errors import DomainError
from fora.ports.usage import UsageCache, UsageObservation

SCHEMA = """
CREATE TABLE IF NOT EXISTS usage_index_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    request_checkpoint INTEGER NOT NULL DEFAULT 0,
    turn_checkpoint INTEGER NOT NULL DEFAULT 0,
    ready INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    error TEXT
);
INSERT OR IGNORE INTO usage_index_state(id, version) VALUES (1, 1);
CREATE TABLE IF NOT EXISTS usage_records (
    record_id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL,
    agent_id INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    ordinal INTEGER,
    started_at TEXT NOT NULL,
    model_key TEXT NOT NULL,
    coverage TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    requests INTEGER,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_time ON usage_records(started_at, record_id);
CREATE INDEX IF NOT EXISTS usage_agent ON usage_records(agent_id, started_at, record_id);
CREATE INDEX IF NOT EXISTS usage_model ON usage_records(model_key, started_at, record_id);
CREATE INDEX IF NOT EXISTS usage_turn ON usage_records(agent_id, sequence);
CREATE INDEX IF NOT EXISTS usage_coverage ON usage_records(coverage, started_at, record_id);
CREATE TRIGGER IF NOT EXISTS usage_member_changed AFTER UPDATE OF name, deleted ON members
BEGIN
    UPDATE usage_index_state SET revision = revision + 1 WHERE id = 1;
END;
"""

PARTIAL_HISTORY = (
    "u.source_kind = 'request' AND EXISTS (SELECT 1 FROM agent_runs t"
    " WHERE t.agent_id = u.agent_id AND t.sequence = u.sequence"
    " AND json_extract(t.usage_json, '$.requests') > (SELECT COUNT(*)"
    " FROM agent_model_requests r WHERE r.agent_id = u.agent_id AND r.sequence = u.sequence))"
)

PUBLIC_MODEL_FIELDS = (
    "api_type",
    "model",
    "model_id",
    "model_name",
    "provider",
    "provider_id",
    "provider_name",
    "registered_model_id",
    "display_name",
    "thinking",
    "thinking_budget_tokens",
)


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def number(usage: dict[str, Any] | None, key: str) -> int | None:
    value = usage.get(key) if usage is not None else None
    if value is None:
        return None
    if type(value) is not int or value < 0:
        raise DomainError("usage_invalid", f"Invalid saved usage field: {key}")
    return value


def utc(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise DomainError("invalid_params", "Usage time must be an ISO 8601 string")
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise DomainError("invalid_params", "Usage time must include a timezone")
    return parsed.astimezone(UTC).isoformat(timespec="microseconds")


class UsageCursor(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    filters: str
    revision: int = Field(ge=0)
    started_at: str
    record_id: str
    direction: Literal["older", "newer"] = "older"
    runtime_epoch: str | None = None
    live_versions: list[tuple[int, int, int]] = Field(default_factory=list)


class DecimalSum:
    def __init__(self) -> None:
        self.total: Decimal | None = None

    def step(self, value: str | None) -> None:
        if value is None:
            return
        amount = Decimal(value)
        if not amount.is_finite():
            raise ValueError("Saved cost must be finite")
        with localcontext() as context:
            context.prec = MAX_PREC
            self.total = amount if self.total is None else self.total + amount

    def finalize(self) -> str | None:
        return str(self.total) if self.total is not None else None


NUMERIC_FIELDS = (
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "requests",
    "cache_read_tokens",
    "cache_write_tokens",
)
KNOWN_FIELDS = (
    "records",
    "input_known",
    "output_known",
    "total_known",
    "requests_known",
    "cache_read_known",
    "cache_write_known",
    "cost_known",
)
METRICS = (
    "COUNT(*) AS records, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,"
    " SUM(total_tokens) AS total_tokens, SUM(requests) AS requests,"
    " COUNT(input_tokens) AS input_known, COUNT(output_tokens) AS output_known,"
    " COUNT(total_tokens) AS total_known, COUNT(requests) AS requests_known,"
    " SUM(json_extract(payload_json, '$.usage.cache_read_tokens')) AS cache_read_tokens,"
    " SUM(json_extract(payload_json, '$.usage.cache_write_tokens')) AS cache_write_tokens,"
    " COUNT(json_extract(payload_json, '$.usage.cache_read_tokens')) AS cache_read_known,"
    " COUNT(json_extract(payload_json, '$.usage.cache_write_tokens')) AS cache_write_known,"
    " usage_decimal_sum(CASE WHEN json_extract(payload_json, '$.cost_source') = 'genai-prices'"
    " THEN json_extract(payload_json, '$.cost') END) AS estimated_cost,"
    " COUNT(CASE WHEN json_extract(payload_json, '$.cost_source') = 'genai-prices'"
    " THEN json_extract(payload_json, '$.cost') END) AS cost_known,"
    " MAX(started_at) AS last_active, json_group_array(DISTINCT model_key) AS model_keys"
)


def merge_metrics(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    result = dict(left)
    for key in KNOWN_FIELDS:
        result[key] = left[key] + right[key]
    for key in NUMERIC_FIELDS:
        known = [int(value) for value in (left[key], right[key]) if value is not None]
        result[key] = sum(known) if known else None
    costs = [
        Decimal(value)
        for value in (left["estimated_cost"], right["estimated_cost"])
        if value is not None
    ]
    with localcontext() as context:
        context.prec = MAX_PREC
        result["estimated_cost"] = str(sum(costs, Decimal(0))) if costs else None
    dates = [
        value
        for value in (left["last_active"], right["last_active"])
        if value is not None
    ]
    result["last_active"] = max(dates) if dates else None
    result["model_keys"] = encode(
        sorted(
            set(json.loads(left["model_keys"])) | set(json.loads(right["model_keys"]))
        )
    )
    return result


def format_metrics(value: dict[str, Any], *, summary: bool = False) -> dict[str, Any]:
    result = dict(value)
    result["model_count"] = len(json.loads(result.pop("model_keys")))
    for key in NUMERIC_FIELDS:
        result[key] = (
            str(result[key])
            if result[key] is not None
            else "0"
            if summary and not result["records"]
            else None
        )
    return result


def combine_aggregates(saved: dict[str, Any], live: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "summary": format_metrics(
            merge_metrics(saved["summary"], live["summary"]), summary=True
        ),
        "coverage": {
            key: saved["coverage"].get(key, 0) + live["coverage"].get(key, 0)
            for key in saved["coverage"].keys() | live["coverage"].keys()
        },
        "groups": {},
    }
    for dimension in ("agent_id", "model_key", "date"):
        saved_rows = (
            saved["daily"] if dimension == "date" else saved["groups"][dimension]
        )
        live_rows = live["daily"] if dimension == "date" else live["groups"][dimension]
        merged = {row[dimension]: row for row in saved_rows}
        for row in live_rows:
            identity = row[dimension]
            merged[identity] = (
                merge_metrics(merged[identity], row) if identity in merged else row
            )
        rows = [format_metrics(merged[key]) for key in sorted(merged)]
        if dimension == "date":
            result["daily"] = rows
        else:
            result["groups"][dimension] = rows
    return result


class UsageIndex:
    def __init__(self, db: LockedConnection) -> None:
        self.db = db
        db.executescript(SCHEMA)
        db.create_aggregate("usage_decimal_sum", 1, DecimalSum)

    def state(self) -> dict[str, Any]:
        row = first(self.db.execute("SELECT * FROM usage_index_state WHERE id = 1"))
        assert row is not None
        return dict(row)

    def _save(self, payload: dict[str, Any]) -> None:
        usage = payload["usage"]
        input_tokens = number(usage, "input_tokens")
        output_tokens = number(usage, "output_tokens")
        total = (
            input_tokens + output_tokens
            if input_tokens is not None and output_tokens is not None
            else None
        )
        requests = (
            1 if payload["source_kind"] == "request" else number(usage, "requests")
        )
        payload.update(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total,
            requests=requests,
        )
        changed = self.db.execute_cursor(
            "INSERT INTO usage_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(record_id) DO UPDATE SET"
            " started_at = excluded.started_at, model_key = excluded.model_key,"
            " coverage = excluded.coverage, input_tokens = excluded.input_tokens,"
            " output_tokens = excluded.output_tokens, total_tokens = excluded.total_tokens,"
            " requests = excluded.requests, payload_json = excluded.payload_json"
            " WHERE payload_json != excluded.payload_json",
            (
                payload["record_id"],
                payload["source_kind"],
                payload["agent_id"],
                payload["sequence"],
                payload["ordinal"],
                payload["started_at"],
                payload["model_key"],
                payload["coverage"],
                input_tokens,
                output_tokens,
                total,
                requests,
                encode(payload),
            ),
        )
        if changed.rowcount:
            self.db.execute(
                "UPDATE usage_index_state SET revision = revision + 1 WHERE id = 1"
            )

    def sync_request(self, agent_id: int, sequence: int, ordinal: int) -> None:
        row = first(
            self.db.execute(
                "SELECT * FROM agent_model_requests WHERE agent_id = ? AND sequence = ? AND ordinal = ?",
                (agent_id, sequence, ordinal),
            )
        )
        assert row is not None
        raw_model = json.loads(row["model_json"])
        model = {key: raw_model[key] for key in PUBLIC_MODEL_FIELDS if key in raw_model}
        identity = (
            ["configuration", model["provider_id"], model["registered_model_id"]]
            if model.get("provider_id") and model.get("registered_model_id")
            else [
                "remote",
                model.get("api_type"),
                model.get("provider"),
                model.get("model_name"),
                model.get("model"),
            ]
        )
        responses = self.db.execute(
            "SELECT b.content_json FROM agent_model_request_messages r"
            " JOIN agent_history_message_blobs b ON b.content_hash = r.content_hash"
            " WHERE r.agent_id = ? AND r.sequence = ? AND r.ordinal = ?"
            " AND r.channel = 'response' ORDER BY r.position",
            (agent_id, sequence, ordinal),
        )
        messages = [
            message
            for item in responses
            for message in json.loads(item["content_json"], parse_float=Decimal)
        ]
        if not messages and row["response_json"] is not None:
            messages = json.loads(row["response_json"], parse_float=Decimal)
        if len(messages) > 1 or (messages and messages[0].get("kind") != "response"):
            raise DomainError(
                "usage_invalid", f"Invalid response for {agent_id}/{sequence}/{ordinal}"
            )
        response = messages[0] if messages else None
        usage = response.get("usage") if response is not None else None
        if usage is not None and not isinstance(usage, dict):
            raise DomainError(
                "usage_invalid", f"Invalid usage for {agent_id}/{sequence}/{ordinal}"
            )
        metadata = (
            (response.get("metadata") or {}).get("fora_usage", {}) if response else {}
        )
        coverage = (
            "in_progress"
            if row["status"] == "pending"
            else "no_response"
            if response is None
            else "missing_usage"
            if usage is None
            else "field_missing"
            if number(usage, "input_tokens") is None
            or number(usage, "output_tokens") is None
            else "recorded"
        )
        self._save(
            {
                "record_id": f"request:{agent_id}:{sequence}:{ordinal}",
                "source_kind": "request",
                "agent_id": agent_id,
                "sequence": sequence,
                "ordinal": ordinal,
                "request_id": row["request_id"],
                "status": row["status"],
                "started_at": utc(row["started_at"]),
                "completed_at": row["completed_at"],
                "model": model,
                "model_key": hashlib.sha256(encode(identity).encode()).hexdigest(),
                "model_identity_source": identity[0],
                "usage": usage,
                "coverage": coverage,
                "cost": str(usage["cost"])
                if usage is not None and usage.get("cost") is not None
                else None,
                "cost_source": metadata.get("cost_source", "historical_response"),
                "currency": metadata.get("currency", "USD"),
                "field_source": metadata.get("field_source", "saved_response"),
                "provider_field_presence": "unknown",
            }
        )
        self.sync_turn(agent_id, sequence)

    def sync_turn(self, agent_id: int, sequence: int) -> None:
        requests = first(
            self.db.execute(
                "SELECT COUNT(*) AS count FROM agent_model_requests WHERE agent_id = ? AND sequence = ?",
                (agent_id, sequence),
            )
        )
        assert requests is not None
        record_id = f"turn:{agent_id}:{sequence}"
        if requests["count"]:
            removed = self.db.execute_cursor(
                "DELETE FROM usage_records WHERE record_id = ?", (record_id,)
            )
            if removed.rowcount:
                self.db.execute(
                    "UPDATE usage_index_state SET revision = revision + 1 WHERE id = 1"
                )
            return
        row = first(
            self.db.execute(
                "SELECT * FROM agent_runs WHERE agent_id = ? AND sequence = ?",
                (agent_id, sequence),
            )
        )
        assert row is not None
        usage = (
            json.loads(row["usage_json"], parse_float=Decimal)
            if row["usage_json"] is not None
            else None
        )
        self._save(
            {
                "record_id": record_id,
                "source_kind": "turn_summary",
                "agent_id": agent_id,
                "sequence": sequence,
                "ordinal": None,
                "request_id": None,
                "status": row["status"],
                "started_at": utc(row["started_at"]),
                "completed_at": row["completed_at"],
                "model": {},
                "model_key": "unknown",
                "model_identity_source": "unknown",
                "usage": usage,
                "coverage": "in_progress"
                if row["status"] == "running"
                else "legacy"
                if usage is not None
                else "missing_history",
                "cost": None,
                "cost_source": "unavailable",
                "currency": "USD",
                "field_source": "turn_summary",
                "provider_field_presence": "unknown",
            }
        )

    def advance(self, limit: int = 100) -> dict[str, Any]:
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise DomainError(
                "invalid_params", "Index batch limit must be between 1 and 1000"
            )
        try:
            return self._advance(limit)
        except (ValueError, TypeError, KeyError, DomainError) as error:
            message = f"Usage index failed: {error}"
            with self.db:
                self.db.execute(
                    "UPDATE usage_index_state SET error = ? WHERE id = 1", (message,)
                )
            raise DomainError("usage_index_failed", message) from error

    def _advance(self, limit: int) -> dict[str, Any]:
        with self.db:
            state = self.state()
            if state["ready"]:
                return state
            requests = self.db.execute(
                "SELECT rowid AS checkpoint, agent_id, sequence, ordinal FROM agent_model_requests"
                " WHERE rowid > ? ORDER BY rowid LIMIT ?",
                (state["request_checkpoint"], limit),
            )
            for row in requests:
                try:
                    self.sync_request(row["agent_id"], row["sequence"], row["ordinal"])
                except (ValueError, TypeError, KeyError, DomainError) as error:
                    raise DomainError(
                        "usage_invalid",
                        f"Request {row['agent_id']}/{row['sequence']}/{row['ordinal']}: {error}",
                    ) from error
                self.db.execute(
                    "UPDATE usage_index_state SET request_checkpoint = ? WHERE id = 1",
                    (row["checkpoint"],),
                )
            turns = self.db.execute(
                "SELECT rowid AS checkpoint, agent_id, sequence FROM agent_runs"
                " WHERE rowid > ? ORDER BY rowid LIMIT ?",
                (state["turn_checkpoint"], limit),
            )
            for row in turns:
                try:
                    self.sync_turn(row["agent_id"], row["sequence"])
                except (ValueError, TypeError, KeyError, DomainError) as error:
                    raise DomainError(
                        "usage_invalid",
                        f"Turn {row['agent_id']}/{row['sequence']}: {error}",
                    ) from error
                self.db.execute(
                    "UPDATE usage_index_state SET turn_checkpoint = ? WHERE id = 1",
                    (row["checkpoint"],),
                )
            if len(requests) < limit and len(turns) < limit:
                self.db.execute(
                    "UPDATE usage_index_state SET ready = 1, revision = revision + 1 WHERE id = 1"
                )
            self.db.execute("UPDATE usage_index_state SET error = NULL WHERE id = 1")
            return self.state()

    def _record(
        self,
        row: Any,
        *,
        detail: bool = False,
        execute: Callable[[str, Sequence[Any]], list[Any]] | None = None,
        table: str = "usage_records",
    ) -> dict[str, Any]:
        payload = json.loads(row["payload_json"])
        payload["agent_name"] = row["agent_name"]
        payload["agent_deleted"] = bool(row["agent_deleted"])
        payload["agent_name_source"] = "retained_member"
        payload.setdefault("saved", True)
        payload.setdefault("observation_source", "persisted")
        for key in ("input_tokens", "output_tokens", "total_tokens", "requests"):
            if payload[key] is not None:
                payload[key] = str(payload[key])
        summary = json.loads(row["turn_usage"]) if row["turn_usage"] else None
        payload["partial_history"] = bool(
            payload["source_kind"] == "request"
            and summary is not None
            and number(summary, "requests") is not None
            and summary["requests"] > row["request_count"]
        )
        if detail:
            payload["turn_summary"] = summary
            payload["turn_summary_json"] = row["turn_usage"]
            payload["traceable_requests"] = row["request_count"]
            totals = first(
                (execute or self.db.execute)(
                    "SELECT SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,"
                    " COUNT(input_tokens) AS input_known, COUNT(output_tokens) AS output_known"
                    f" FROM {table} WHERE agent_id = ? AND sequence = ? AND source_kind = 'request'",
                    (payload["agent_id"], payload["sequence"]),
                )
            )
            payload["summary_mismatch"] = bool(
                summary is not None
                and totals is not None
                and payload["source_kind"] == "request"
                and any(
                    number(summary, key) is not None
                    and totals[key] is not None
                    and totals[known] == row["request_count"]
                    and summary[key] != totals[key]
                    for key, known in (
                        ("input_tokens", "input_known"),
                        ("output_tokens", "output_known"),
                    )
                )
            )
            payload["usage_json"] = json.dumps(
                payload["usage"], ensure_ascii=False, sort_keys=True, indent=2
            )
        else:
            payload.pop("usage")
        return payload

    def _live_records(
        self, observation: UsageObservation | None
    ) -> list[dict[str, Any]]:
        if observation is None:
            return []
        records = []
        for turn in observation.turns:
            rows = {
                (row["ordinal"], row["request_id"]): row
                for row in self.db.execute(
                    "SELECT ordinal, request_id, started_at FROM agent_model_requests"
                    " WHERE agent_id = ? AND sequence = ?",
                    (turn.agent_id, turn.sequence),
                )
            }
            for request in turn.requests:
                row = rows.get((request.ordinal, request.request_id))
                if row is None:
                    raise DomainError(
                        "usage_invalid", "Live request has no saved identity"
                    )
                raw_model = json.loads(request.model_json)
                model = {
                    key: raw_model[key]
                    for key in PUBLIC_MODEL_FIELDS
                    if key in raw_model
                }
                identity = (
                    [
                        "configuration",
                        model["provider_id"],
                        model["registered_model_id"],
                    ]
                    if model.get("provider_id") and model.get("registered_model_id")
                    else [
                        "remote",
                        model.get("api_type"),
                        model.get("provider"),
                        model.get("model_name"),
                        model.get("model"),
                    ]
                )
                usage = (
                    json.loads(request.usage_json, parse_float=Decimal)
                    if request.usage_json is not None
                    else None
                )
                metadata = json.loads(request.metadata_json)
                status = (
                    "completed"
                    if request.usage_json is not None
                    else "pending"
                    if turn.status == "running"
                    else "failed"
                )
                coverage = (
                    "in_progress"
                    if status == "pending"
                    else "no_response"
                    if request.usage_json is None
                    else "missing_usage"
                    if usage is None
                    else "field_missing"
                    if number(usage, "input_tokens") is None
                    or number(usage, "output_tokens") is None
                    else "recorded"
                )
                input_tokens = number(usage, "input_tokens")
                output_tokens = number(usage, "output_tokens")
                records.append(
                    {
                        "record_id": f"request:{turn.agent_id}:{turn.sequence}:{request.ordinal}",
                        "source_kind": "request",
                        "agent_id": turn.agent_id,
                        "sequence": turn.sequence,
                        "ordinal": request.ordinal,
                        "request_id": request.request_id,
                        "status": status,
                        "started_at": utc(row["started_at"]),
                        "completed_at": request.completed_at,
                        "model": model,
                        "model_key": hashlib.sha256(
                            encode(identity).encode()
                        ).hexdigest(),
                        "model_identity_source": identity[0],
                        "usage": usage,
                        "coverage": coverage,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "total_tokens": input_tokens + output_tokens
                        if input_tokens is not None and output_tokens is not None
                        else None,
                        "requests": 1,
                        "cost": str(usage["cost"])
                        if usage is not None and usage.get("cost") is not None
                        else None,
                        "cost_source": metadata.get(
                            "cost_source", "historical_response"
                        ),
                        "currency": metadata.get("currency", "USD"),
                        "field_source": metadata.get("field_source", "saved_response"),
                        "provider_field_presence": "unknown",
                        "saved": request.saved,
                        "observation_source": "runtime",
                    }
                )
        return records

    def _sources(
        self, observation: UsageObservation | None
    ) -> tuple[str, tuple[str, str]]:
        columns = (
            "record_id",
            "source_kind",
            "agent_id",
            "sequence",
            "ordinal",
            "started_at",
            "model_key",
            "coverage",
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "requests",
        )
        projection = ", ".join(
            f"json_extract(value, '$.{column}') AS {column}" for column in columns
        )
        prefix = (
            "WITH live_usage AS (SELECT "
            + projection
            + ", value AS payload_json FROM json_each(?)),"
            " persisted_usage AS (SELECT u.* FROM usage_records u WHERE NOT EXISTS"
            " (SELECT 1 FROM json_each(?) a WHERE json_extract(a.value, '$[0]') = u.agent_id"
            " AND json_extract(a.value, '$[1]') = u.sequence)),"
            " observed_usage AS (SELECT * FROM persisted_usage UNION ALL SELECT * FROM live_usage) "
        )
        excluded = (
            [(turn.agent_id, turn.sequence) for turn in observation.turns]
            if observation is not None
            else []
        )
        return prefix, (
            encode(self._live_records(observation)),
            encode(sorted(excluded)),
        )

    def _aggregates(
        self,
        execute: Callable[[str, Sequence[Any]], list[Any]],
        table: str,
        where: str,
        values: Sequence[Any],
    ) -> dict[str, Any]:
        source = f" FROM {table} u"
        totals = first(execute("SELECT " + METRICS + source + where, values))
        assert totals is not None
        coverage = {
            row["coverage"]: row["count"]
            for row in execute(
                "SELECT coverage, COUNT(*) AS count"
                + source
                + where
                + " GROUP BY coverage",
                values,
            )
        }
        partial = first(
            execute(
                "SELECT COUNT(*) AS count" + source + where + " AND " + PARTIAL_HISTORY,
                values,
            )
        )
        if partial is not None and partial["count"]:
            coverage["partial_history"] = partial["count"]
        groups = {
            dimension: [
                dict(row)
                for row in execute(
                    "SELECT "
                    + dimension
                    + ", "
                    + METRICS
                    + source
                    + where
                    + " GROUP BY "
                    + dimension,
                    values,
                )
            ]
            for dimension in ("agent_id", "model_key")
        }
        daily = [
            dict(row)
            for row in execute(
                "SELECT substr(started_at, 1, 10) AS date, "
                + METRICS
                + source
                + where
                + " GROUP BY date ORDER BY date",
                values,
            )
        ]
        return {
            "summary": dict(totals),
            "coverage": coverage,
            "groups": groups,
            "daily": daily,
        }

    def _select(self, table: str = "usage_records") -> str:
        return (
            "SELECT u.*, m.name AS agent_name, m.deleted AS agent_deleted,"
            " t.usage_json AS turn_usage, (SELECT COUNT(*) FROM agent_model_requests r"
            " WHERE r.agent_id = u.agent_id AND r.sequence = u.sequence) AS request_count"
            f" FROM {table} u JOIN members m ON m.id = u.agent_id"
            " JOIN agent_runs t ON t.agent_id = u.agent_id AND t.sequence = u.sequence"
        )

    def read(
        self, record_id: str, *, observation: UsageObservation | None = None
    ) -> dict[str, Any]:
        if not isinstance(record_id, str) or not record_id:
            raise DomainError("invalid_params", "Usage record_id must be a string")
        with self.db.read():
            prefix, source_values = self._sources(observation)

            def execute(sql: str, parameters: Sequence[Any] = ()) -> list[Any]:
                return self.db.execute(prefix + sql, (*source_values, *parameters))

            row = first(
                execute(
                    self._select("observed_usage") + " WHERE u.record_id = ?",
                    (record_id,),
                )
            )
            if row is None:
                raise DomainError("not_found", "Usage record does not exist")
            return {
                "dataset_revision": self.state()["revision"],
                "runtime_epoch": observation.runtime_epoch
                if observation is not None
                else None,
                "live_versions": list(observation.versions)
                if observation is not None
                else [],
                **self._record(
                    row, detail=True, execute=execute, table="observed_usage"
                ),
            }

    def display(
        self,
        observation: UsageObservation,
        *,
        agent_id: int | None = None,
        sequences: Sequence[int] = (),
        cache: UsageCache | None = None,
    ) -> dict[str, Any]:
        with self.db.read():
            self.db.current.create_aggregate("usage_decimal_sum", 1, DecimalSum)
            state = self.state()
            prefix, source_values = self._sources(observation)
            where = " WHERE coverage IN ('recorded', 'field_missing', 'missing_usage', 'legacy')"
            values: tuple[int, ...] = ()
            if agent_id is not None:
                where += " AND agent_id = ?"
                values = (agent_id,)
            cache_key = encode(
                ("display", agent_id, state["revision"], source_values[1])
            )

            def groups(table: str) -> list[dict[str, Any]]:
                return [
                    dict(row)
                    for row in self.db.execute(
                        prefix
                        + "SELECT agent_id, "
                        + METRICS
                        + f" FROM {table} u"
                        + where
                        + " GROUP BY agent_id",
                        (*source_values, *values),
                    )
                ]

            def build_saved() -> str:
                return encode(groups("persisted_usage"))

            saved = json.loads(
                cache.obtain(cache_key, build_saved)
                if cache is not None
                else build_saved()
            )
            merged = {row["agent_id"]: row for row in saved}
            for row in groups("live_usage"):
                identity = row["agent_id"]
                merged[identity] = (
                    merge_metrics(merged[identity], row) if identity in merged else row
                )
            empty = first(
                self.db.execute("SELECT " + METRICS + " FROM usage_records WHERE 0")
            )
            assert empty is not None
            totals = dict(empty)
            for row in merged.values():
                totals = merge_metrics(totals, row)
            turns = {}
            if sequences:
                assert agent_id is not None
                placeholders = ",".join("?" for _ in sequences)
                for turn_row in self.db.execute(
                    prefix
                    + "SELECT sequence, "
                    + METRICS
                    + " FROM observed_usage u"
                    + where
                    + f" AND sequence IN ({placeholders}) GROUP BY sequence",
                    (*source_values, *values, *sequences),
                ):
                    turns[turn_row["sequence"]] = format_metrics(dict(turn_row))
            return {
                "summary": format_metrics(totals, summary=True),
                "groups": {
                    "agent_id": [format_metrics(merged[key]) for key in sorted(merged)]
                },
                "dataset_revision": state["revision"],
                "runtime_epoch": observation.runtime_epoch,
                "live_versions": list(observation.versions),
                "index": state,
                "turns": turns,
            }

    def query(
        self,
        params: dict[str, Any],
        *,
        observation: UsageObservation | None = None,
        cache: UsageCache | None = None,
        advance: bool = True,
    ) -> dict[str, Any]:
        limit = params.get("limit", 20)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise DomainError("invalid_params", "Usage limit must be between 1 and 100")
        filters = {
            key: params.get(key) for key in ("agent_id", "model_key", "coverage")
        }
        contributions_only = params.get("contributions_only", False)
        if type(contributions_only) is not bool:
            raise DomainError("invalid_params", "contributions_only must be a boolean")
        filters.update(
            start_at=utc(params.get("start_at")),
            end_at=utc(params.get("end_at")),
            contributions_only=contributions_only,
        )
        if filters["agent_id"] is not None and (
            type(filters["agent_id"]) is not int or filters["agent_id"] <= 0
        ):
            raise DomainError("invalid_params", "agent_id must be a positive integer")
        for key in ("model_key", "coverage"):
            if filters[key] is not None and not isinstance(filters[key], str):
                raise DomainError("invalid_params", f"{key} must be a string")
        if filters["coverage"] not in (
            None,
            "recorded",
            "in_progress",
            "no_response",
            "missing_usage",
            "field_missing",
            "legacy",
            "missing_history",
            "partial_history",
        ):
            raise DomainError("invalid_params", "Unknown usage coverage filter")
        if params.get("anchor") is not None and not isinstance(params["anchor"], str):
            raise DomainError("invalid_params", "Usage anchor must be a string")
        if (
            params.get("dataset_revision") is not None
            and type(params["dataset_revision"]) is not int
        ):
            raise DomainError("invalid_params", "Usage revision must be an integer")
        if (
            filters["start_at"]
            and filters["end_at"]
            and filters["start_at"] >= filters["end_at"]
        ):
            raise DomainError("invalid_params", "Usage start must precede end")
        clauses, values = [], []
        for key, operation in (
            ("agent_id", "="),
            ("model_key", "="),
            ("coverage", "="),
            ("start_at", ">="),
            ("end_at", "<"),
        ):
            if key == "coverage" and filters[key] == "partial_history":
                clauses.append(PARTIAL_HISTORY)
                continue
            if filters[key] is not None:
                column = "started_at" if key in ("start_at", "end_at") else key
                clauses.append(f"u.{column} {operation} ?")
                values.append(filters[key])
        if contributions_only:
            clauses.append(
                "u.coverage IN ('recorded', 'field_missing', 'missing_usage', 'legacy')"
            )
        where = " WHERE " + " AND ".join(clauses) if clauses else " WHERE 1"
        signature = hashlib.sha256(encode(filters).encode()).hexdigest()
        if advance:
            self.advance()
        with self.db if advance else self.db.read():
            self.db.current.create_aggregate("usage_decimal_sum", 1, DecimalSum)
            state = self.state()
            revision = state["revision"]
            epoch = observation.runtime_epoch if observation is not None else None
            versions = list(observation.versions) if observation is not None else []
            prefix, source_values = self._sources(observation)

            def execute(sql: str, parameters: Sequence[Any] = ()) -> list[Any]:
                return self.db.execute(prefix + sql, (*source_values, *parameters))

            for key, actual in (("runtime_epoch", epoch), ("live_versions", versions)):
                if (
                    key in params
                    and params[key] != actual
                    and params[key] != json.loads(encode(actual))
                ):
                    raise DomainError(
                        "usage_changed", "Usage observation changed; refresh this range"
                    )
            expected = params.get("dataset_revision")
            if expected is not None and expected != revision:
                raise DomainError(
                    "usage_changed", "Usage data changed; refresh this range"
                )
            cursor = params.get("cursor")
            page_clause, page_values = "", []
            direction = "older"
            if cursor is not None:
                if not isinstance(cursor, str):
                    raise DomainError("invalid_params", "Usage cursor must be a string")
                position = UsageCursor.model_validate_json(cursor).model_dump()
                if position.get("filters") != signature:
                    raise DomainError(
                        "invalid_params", "Usage cursor belongs to another range"
                    )
                if (
                    position.get("revision") != revision
                    or position["runtime_epoch"] != epoch
                    or position["live_versions"] != versions
                ):
                    raise DomainError(
                        "usage_changed", "Usage data changed; refresh this range"
                    )
                direction = position.get("direction", "older")
                if direction not in ("older", "newer"):
                    raise DomainError(
                        "invalid_params", "Invalid usage cursor direction"
                    )
                comparison = ">" if direction == "newer" else "<"
                page_clause = f" AND (u.started_at, u.record_id) {comparison} (?, ?)"
                page_values = [position["started_at"], position["record_id"]]
            elif params.get("anchor"):
                anchor = first(
                    execute(
                        "SELECT started_at, record_id FROM observed_usage u"
                        + where
                        + " AND record_id = ?",
                        (*values, params["anchor"]),
                    )
                )
                if anchor is not None:
                    page_clause = " AND (u.started_at, u.record_id) <= (?, ?)"
                    page_values = [anchor["started_at"], anchor["record_id"]]
            cache_key = encode((signature, revision, source_values[1]))

            def build_saved() -> str:
                return encode(
                    self._aggregates(execute, "persisted_usage", where, values)
                )

            saved = json.loads(
                cache.obtain(cache_key, build_saved)
                if cache is not None
                else build_saved()
            )
            live = self._aggregates(execute, "live_usage", where, values)
            aggregates = combine_aggregates(saved, live)
            order = "ASC" if direction == "newer" else "DESC"
            rows = [
                row
                for table in ("persisted_usage", "live_usage")
                for row in execute(
                    self._select(table)
                    + where
                    + page_clause
                    + f" ORDER BY u.started_at {order}, u.record_id {order} LIMIT ?",
                    (*values, *page_values, limit),
                )
            ]
            rows.sort(
                key=lambda row: (row["started_at"], row["record_id"]),
                reverse=direction == "older",
            )
            records = [self._record(row) for row in rows[:limit]]
            if direction == "newer":
                records.reverse()
            cursors = {}
            for name, record, comparison in (
                ("older", records[-1] if records else None, "<"),
                ("newer", records[0] if records else None, ">"),
            ):
                exists = record is not None and execute(
                    "SELECT 1 FROM observed_usage u"
                    + where
                    + f" AND (u.started_at, u.record_id) {comparison} (?, ?) LIMIT 1",
                    (*values, record["started_at"], record["record_id"]),
                )
                cursors[name] = (
                    encode(
                        {
                            "filters": signature,
                            "revision": revision,
                            "runtime_epoch": epoch,
                            "live_versions": versions,
                            "direction": name,
                            "started_at": record["started_at"],
                            "record_id": record["record_id"],
                        }
                    )
                    if exists and record is not None
                    else None
                )
            next_cursor = cursors["older"]
            has_more = next_cursor is not None
            agents = [
                dict(row)
                for row in execute(
                    "SELECT DISTINCT m.id, m.name, m.deleted FROM observed_usage u JOIN members m ON m.id = u.agent_id ORDER BY m.name"
                )
            ]
            models = [
                {
                    "key": row["model_key"],
                    "model": json.loads(row["payload_json"])["model"],
                }
                for row in execute(
                    "SELECT model_key, payload_json FROM observed_usage GROUP BY model_key ORDER BY model_key"
                )
            ]
            return {
                "filters": filters,
                "dataset_revision": revision,
                "index": state,
                "runtime_epoch": epoch,
                "live_versions": versions,
                **aggregates,
                "records": records,
                "has_more": has_more,
                "next_cursor": next_cursor,
                "previous_cursor": cursors["newer"],
                "agents": agents,
                "models": models,
            }
