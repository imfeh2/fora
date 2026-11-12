from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from collections.abc import Sequence
from dataclasses import asdict

from pydantic import ValidationError

from fora.adapters.model.config import (
    AgentModelConfig,
    ModelCatalog,
    thinking_options,
)
from fora.adapters.sqlite.store import (
    LockedConnection,
    create_member,
    delete_member,
    first,
    reading,
)
from fora.adapters.voice.config import VoiceConfig
from fora.core.blocks import WindowContent
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.core.member import name_key, validate_name
from fora.core.parameters import validate_parameters
from fora.core.turn import OVERFLOW_CONTEXT_BYTES, model_error_signature
from fora.ports.agent import (
    AgentLifecycle,
    AgentRun,
    HistorySlice,
    ModelRequestHandle,
    RunSummary,
    TurnEffect,
    WindowState,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_safety (
    agent_id INTEGER PRIMARY KEY,
    resumed_after INTEGER NOT NULL DEFAULT 0,
    pause_reason TEXT
);
CREATE TABLE IF NOT EXISTS agent_lifecycle (
    agent_id INTEGER PRIMARY KEY,
    pause_requested INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    prepared_sequence INTEGER
);
CREATE TABLE IF NOT EXISTS preparation_mentions (
    agent_id INTEGER NOT NULL,
    discussion_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    PRIMARY KEY (agent_id, discussion_id, message_id)
);
CREATE TABLE IF NOT EXISTS agent_windows (
    agent_id INTEGER PRIMARY KEY,
    number INTEGER NOT NULL,
    since_sequence INTEGER NOT NULL,
    reset_at TEXT,
    reason TEXT,
    overflow_context TEXT
);
CREATE TABLE IF NOT EXISTS agent_window_events (
    agent_id INTEGER NOT NULL,
    number INTEGER NOT NULL,
    since_sequence INTEGER NOT NULL,
    reset_at TEXT,
    reason TEXT,
    overflow_context TEXT,
    PRIMARY KEY (agent_id, number)
);
CREATE TABLE IF NOT EXISTS agent_sessions (
    agent_id INTEGER PRIMARY KEY,
    start_after INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    section TEXT PRIMARY KEY,
    values_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminded (
    agent_id INTEGER NOT NULL,
    discussion_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    first_reminded_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, discussion_id, message_id)
);
CREATE TABLE IF NOT EXISTS run_effects (
    agent_id INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, sequence, ordinal)
);
CREATE TABLE IF NOT EXISTS agent_messages (
    agent_id INTEGER NOT NULL,
    window_number INTEGER NOT NULL,
    position INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    digest BLOB NOT NULL,
    char_length INTEGER NOT NULL,
    content_json TEXT NOT NULL,
    UNIQUE (agent_id, window_number, position),
    FOREIGN KEY (agent_id, sequence) REFERENCES agent_runs(agent_id, sequence)
);
CREATE INDEX IF NOT EXISTS agent_messages_digest
ON agent_messages (agent_id, window_number, position, sequence, digest);
CREATE INDEX IF NOT EXISTS agent_messages_run
ON agent_messages (agent_id, sequence, position, char_length);
CREATE TABLE IF NOT EXISTS agent_request_payloads (
    digest BLOB PRIMARY KEY,
    content_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_model_requests (
    agent_id INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    window_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    streaming INTEGER NOT NULL,
    input_count INTEGER NOT NULL,
    parameters_digest BLOB NOT NULL REFERENCES agent_request_payloads(digest),
    settings_digest BLOB NOT NULL REFERENCES agent_request_payloads(digest),
    model_digest BLOB NOT NULL REFERENCES agent_request_payloads(digest),
    error TEXT,
    PRIMARY KEY (agent_id, sequence, ordinal)
);
CREATE INDEX IF NOT EXISTS agent_model_requests_window
ON agent_model_requests (agent_id, window_number, sequence, ordinal);
"""


def digest(content: str) -> bytes:
    return hashlib.blake2b(content.encode("utf-8"), digest_size=16).digest()


class SqliteAgentStore:
    def __init__(self, db: LockedConnection) -> None:
        self._db = db
        self._db.executescript(SCHEMA)
        with self._db:
            self._db.execute(
                "INSERT OR IGNORE INTO agent_window_events "
                "(agent_id, number, since_sequence, reset_at, reason, overflow_context) "
                "SELECT agent_id, number, since_sequence, reset_at, reason, overflow_context "
                "FROM agent_windows"
            )
        with self._db:
            self.set_settings(
                "model", ModelCatalog.restore(self.get_settings("model")).model_dump()
            )

    def transaction(self) -> LockedConnection:
        return self._db

    @reading
    def pending_revision(self, agent_id: int) -> int:
        row = first(
            self._db.execute(
                "SELECT revision FROM pending_revisions WHERE member_id = ?",
                (agent_id,),
            )
        )
        return int(row["revision"]) if row is not None else 0

    @reading
    def repeated_turns(self, agent_id: int, keys: Sequence[tuple[int, int]]) -> int:
        if not keys:
            return 0
        with self._db:
            row = first(
                self._db.execute(
                    "SELECT COUNT(*) AS total FROM (SELECT 1 FROM agent_runs"
                    " WHERE agent_id = ? AND pending_revision = ?"
                    " AND status = 'completed' AND reminded_json = ?"
                    " AND sequence > COALESCE((SELECT resumed_after FROM agent_safety"
                    " WHERE agent_id = ?), 0) ORDER BY sequence DESC LIMIT 3)",
                    (
                        agent_id,
                        self.pending_revision(agent_id),
                        json.dumps(sorted(set(keys))),
                        agent_id,
                    ),
                )
            )
            assert row is not None
            return int(row["total"])

    @reading
    def lifecycle(self, agent_id: int) -> AgentLifecycle:
        row = first(
            self._db.execute(
                "SELECT pause_requested, error, prepared_sequence FROM agent_lifecycle WHERE agent_id = ?",
                (agent_id,),
            )
        )
        if row is not None:
            return AgentLifecycle(bool(row[0]), row[1], row[2])
        member = first(
            self._db.execute("SELECT state FROM members WHERE id = ?", (agent_id,))
        )
        return AgentLifecycle(
            pause_requested=member is not None and member[0] == "paused"
        )

    def set_lifecycle(self, agent_id: int, value: AgentLifecycle) -> None:
        with self._db:
            self._db.execute(
                "INSERT INTO agent_lifecycle (agent_id, pause_requested, error, prepared_sequence)"
                " VALUES (?, ?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET"
                " pause_requested = excluded.pause_requested, error = excluded.error,"
                " prepared_sequence = excluded.prepared_sequence",
                (agent_id, value.pause_requested, value.error, value.prepared_sequence),
            )

    def consume_preparation(
        self, agent_id: int, sequence: int, keys: Sequence[tuple[int, int]]
    ) -> None:
        with self._db:
            self._db.executemany(
                "INSERT OR IGNORE INTO preparation_mentions (agent_id, discussion_id, message_id, sequence)"
                " VALUES (?, ?, ?, ?)",
                [
                    (agent_id, discussion_id, message_id, sequence)
                    for discussion_id, message_id in keys
                ],
            )

    @reading
    def new_mentions(
        self, agent_id: int, keys: Sequence[tuple[int, int]]
    ) -> frozenset[tuple[int, int]]:
        with self._db:
            consumed = {
                (int(row[0]), int(row[1]))
                for row in self._db.execute(
                    "SELECT discussion_id, message_id FROM reminded WHERE agent_id = ?"
                    " UNION SELECT discussion_id, message_id FROM preparation_mentions WHERE agent_id = ?",
                    (agent_id, agent_id),
                )
            }
            return frozenset(keys) - consumed

    @reading
    def prepared_mentions(
        self, agent_id: int, sequence: int
    ) -> frozenset[tuple[int, int]]:
        return frozenset(
            (int(row[0]), int(row[1]))
            for row in self._db.execute(
                "SELECT discussion_id, message_id FROM preparation_mentions WHERE agent_id = ? AND sequence = ?",
                (agent_id, sequence),
            )
        )

    def _now(self) -> str:
        from fora.adapters.sqlite.store import now

        return now()

    def _run(self, row: sqlite3.Row) -> AgentRun:
        return AgentRun(
            agent_id=int(row["agent_id"]),
            sequence=int(row["sequence"]),
            run_id=str(row["run_id"]),
            status=str(row["status"]),
            started_at=str(row["started_at"]),
            completed_at=row["completed_at"],
            usage_json=row["usage_json"],
            error=row["error"],
            window_number=int(row["window_number"]),
            pending_revision=int(row["pending_revision"]),
        )

    @reading
    def previously_reminded(
        self, agent_id: int, keys: Sequence[tuple[int, int]]
    ) -> frozenset[tuple[int, int]]:
        if not keys:
            return frozenset()
        found: set[tuple[int, int]] = set()
        for discussion_id, message_id in keys:
            row = first(
                self._db.execute(
                    "SELECT 1 FROM reminded WHERE agent_id = ? AND discussion_id = ?"
                    " AND message_id = ?",
                    (agent_id, discussion_id, message_id),
                )
            )
            if row is not None:
                found.add((discussion_id, message_id))
        return frozenset(found)

    @reading
    def last_reminder(self, agent_id: int) -> frozenset[tuple[int, int]]:
        row = first(
            self._db.execute(
                "SELECT reminded_json FROM agent_runs WHERE agent_id = ?"
                " AND sequence > COALESCE((SELECT resumed_after FROM agent_safety"
                " WHERE agent_id = ?), 0)"
                " AND sequence > COALESCE((SELECT start_after FROM agent_sessions"
                " WHERE agent_id = ?), 0)"
                " AND reminded_json != '[]' ORDER BY sequence DESC LIMIT 1",
                (agent_id, agent_id, agent_id),
            )
        )
        return (
            frozenset((int(d), int(m)) for d, m in json.loads(row["reminded_json"]))
            if row is not None
            else frozenset()
        )

    @reading
    def no_tool_streak(self, agent_id: int) -> int:
        rows = self._db.execute(
            "SELECT status, usage_json FROM agent_runs WHERE agent_id = ?"
            " AND sequence > COALESCE((SELECT resumed_after FROM agent_safety"
            " WHERE agent_id = ?), 0) ORDER BY sequence DESC",
            (agent_id, agent_id),
        )
        streak = 0
        for row in rows:
            calls = json.loads(row["usage_json"] or "{}").get("tool_calls")
            if type(calls) is int and calls > 0:
                break
            if row["status"] != "completed":
                continue
            if type(calls) is not int or calls != 0:
                break
            streak += 1
        return streak

    @reading
    def preparation_failure_streak(self, agent_id: int, sequence: int) -> int:
        window = self.window(agent_id)
        rows = self._db.execute(
            "SELECT m.sequence, m.ordinal, m.status, m.error,"
            " r.status AS run_status, r.error AS run_error, r.reminded_json,"
            " m.ordinal = (SELECT MAX(last.ordinal) FROM agent_model_requests last"
            " WHERE last.agent_id = m.agent_id AND last.sequence = m.sequence) AS is_last"
            " FROM agent_model_requests m JOIN agent_runs r"
            " ON r.agent_id = m.agent_id AND r.sequence = m.sequence"
            " WHERE m.agent_id = ? AND m.window_number = ? AND r.window_number = ?"
            " AND m.sequence >= ? ORDER BY m.sequence DESC, m.ordinal DESC LIMIT 3",
            (agent_id, window.number, window.number, window.since_sequence),
        )
        if not rows or rows[0]["sequence"] != sequence:
            return 0
        signature = None
        streak = 0
        for row in rows:
            if row["reminded_json"] != "[]" or row["run_status"] != "failed":
                break
            error = row["error"]
            if row["status"] == "responded" and row["is_last"]:
                error = row["run_error"]
                if not error or not error.startswith(
                    (
                        "UnexpectedModelBehavior:",
                        "ContentFilterError:",
                        "IncompleteToolCall:",
                    )
                ):
                    break
            elif row["status"] != "failed":
                break
            if (
                not error
                or error != row["run_error"]
                or error.startswith(
                    (
                        "HistoryPersistenceError:",
                        "HistoryValidationError:",
                        "UsageLimitExceeded:",
                        "RunCancelled:",
                        "CancelledError:",
                        "ToolFailed:",
                        "ToolRetryError:",
                        "ToolFailedError:",
                        "ModelRetry:",
                        "UserError:",
                    )
                )
            ):
                break
            current = model_error_signature(error)
            if signature is not None and signature != current:
                break
            signature = current
            streak += 1
        return streak

    @reading
    def pause_reason(self, agent_id: int) -> str | None:
        row = first(
            self._db.execute(
                "SELECT pause_reason FROM agent_safety WHERE agent_id = ?", (agent_id,)
            )
        )
        return row["pause_reason"] if row is not None else None

    def pause_for_safety(self, agent_id: int, reason: str) -> None:
        with self._db:
            self._db.execute(
                "INSERT INTO agent_safety (agent_id, pause_reason) VALUES (?, ?)"
                " ON CONFLICT (agent_id) DO UPDATE SET pause_reason = excluded.pause_reason",
                (agent_id, reason),
            )

    def reset_safety(self, agent_id: int) -> None:
        with self._db:
            self._db.execute(
                "INSERT INTO agent_safety (agent_id, resumed_after) VALUES"
                " (?, (SELECT COALESCE(MAX(sequence), 0) FROM agent_runs WHERE agent_id = ?))"
                " ON CONFLICT (agent_id) DO UPDATE SET"
                " resumed_after = excluded.resumed_after, pause_reason = NULL",
                (agent_id, agent_id),
            )

    def start_run(
        self,
        agent_id: int,
        run_id: str | None = None,
        reminded: Sequence[tuple[int, int]] = (),
    ) -> AgentRun:
        row = first(
            self._db.execute(
                "SELECT COALESCE(MAX(sequence), 0) + 1 AS v FROM agent_runs WHERE agent_id = ?",
                (agent_id,),
            )
        )
        assert row is not None
        sequence = int(row["v"])
        identifier = run_id or uuid.uuid4().hex
        started = self._now()
        current_window = self.window(agent_id)
        with self._db:
            revision = self.pending_revision(agent_id)
            self._db.execute(
                "INSERT OR IGNORE INTO agent_window_events"
                " (agent_id, number, since_sequence, reset_at, reason)"
                " VALUES (?, ?, ?, ?, ?)",
                (
                    agent_id,
                    current_window.number,
                    current_window.since_sequence,
                    current_window.reset_at,
                    current_window.reason,
                ),
            )
            self._db.execute(
                "INSERT INTO agent_runs (agent_id, sequence, run_id, status, started_at,"
                " window_number, last_saved_at, reminded_json, pending_revision)"
                " VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)",
                (
                    agent_id,
                    sequence,
                    identifier,
                    started,
                    current_window.number,
                    started,
                    json.dumps(sorted(set(reminded))),
                    revision,
                ),
            )
            self._db.executemany(
                "INSERT OR IGNORE INTO reminded (agent_id, discussion_id, message_id,"
                " first_reminded_at) VALUES (?, ?, ?, ?)",
                [
                    (agent_id, discussion_id, message_id, started)
                    for discussion_id, message_id in reminded
                ],
            )
            self._db.executemany(
                "DELETE FROM preparation_mentions WHERE agent_id = ? AND discussion_id = ? AND message_id = ?",
                [
                    (agent_id, discussion_id, message_id)
                    for discussion_id, message_id in reminded
                ],
            )
        return AgentRun(
            agent_id=agent_id,
            sequence=sequence,
            run_id=identifier,
            status="running",
            started_at=started,
            completed_at=None,
            usage_json=None,
            error=None,
            window_number=current_window.number,
            pending_revision=revision,
        )

    def _write_messages(
        self, agent_id: int, sequence: int, content: WindowContent
    ) -> None:
        messages = content.messages
        run = first(
            self._db.execute(
                "SELECT window_number FROM agent_runs WHERE agent_id = ? AND sequence = ?",
                (agent_id, sequence),
            )
        )
        if run is None:
            raise DomainError(ErrorCode.NOT_FOUND, f"Turn {sequence} does not exist")
        window_number = int(run["window_number"])
        stored = self._db.execute(
            "SELECT sequence, digest FROM agent_messages INDEXED BY agent_messages_digest"
            " WHERE agent_id = ? AND window_number = ? ORDER BY position",
            (agent_id, window_number),
        )
        digests = [digest(message) for message in messages]
        kept = 0
        for row, value in zip(stored, digests, strict=False):
            if row["digest"] != value:
                break
            kept += 1
        if kept == len(stored) == len(messages):
            return
        self._db.execute(
            "DELETE FROM agent_messages WHERE agent_id = ? AND window_number = ?"
            " AND position >= ?",
            (agent_id, window_number, kept),
        )
        self._db.executemany(
            "INSERT INTO agent_messages (agent_id, window_number, position, sequence,"
            " digest, char_length, content_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    agent_id,
                    window_number,
                    position,
                    int(stored[position]["sequence"])
                    if position < len(stored)
                    else sequence,
                    digests[position],
                    len(messages[position]),
                    messages[position],
                )
                for position in range(kept, len(messages))
            ],
        ).close()

    def save_history(
        self, agent_id: int, sequence: int, content: WindowContent
    ) -> None:
        with self._db:
            self._write_messages(agent_id, sequence, content)
            self._db.execute(
                "UPDATE agent_runs SET last_saved_at = ? WHERE agent_id = ? AND sequence = ?",
                (self._now(), agent_id, sequence),
            )

    def finish_run(
        self,
        agent_id: int,
        sequence: int,
        *,
        status: str,
        content: WindowContent,
        usage_json: str | None = None,
        error: str | None = None,
    ) -> None:
        with self._db:
            self._write_messages(agent_id, sequence, content)
            self._db.execute(
                "UPDATE agent_runs SET status = ?, completed_at = ?, last_saved_at = ?,"
                " usage_json = ?, error = ? WHERE agent_id = ? AND sequence = ?",
                (
                    status,
                    self._now(),
                    self._now(),
                    usage_json,
                    error,
                    agent_id,
                    sequence,
                ),
            )
            if status == "interrupted":
                self._db.execute(
                    "UPDATE agent_model_requests SET status = 'interrupted',"
                    " completed_at = ? WHERE agent_id = ? AND sequence = ?"
                    " AND status = 'pending'",
                    (self._now(), agent_id, sequence),
                )

    def start_model_request(
        self,
        agent_id: int,
        sequence: int,
        window_number: int,
        input_count: int,
        parameters_json: str,
        settings_json: str,
        model_json: str,
        streaming: bool,
    ) -> ModelRequestHandle:
        payloads = tuple(
            (digest(value), value)
            for value in (parameters_json, settings_json, model_json)
        )
        request_id = uuid.uuid4().hex
        started = self._now()
        with self._db:
            self._db.executemany(
                "INSERT OR IGNORE INTO agent_request_payloads (digest, content_json)"
                " VALUES (?, ?)",
                payloads,
            ).close()
            row = first(
                self._db.execute(
                    "SELECT COALESCE(MAX(ordinal), 0) + 1 AS v FROM agent_model_requests"
                    " WHERE agent_id = ? AND sequence = ?",
                    (agent_id, sequence),
                )
            )
            assert row is not None
            ordinal = int(row["v"])
            self._db.execute(
                "INSERT INTO agent_model_requests (agent_id, sequence, ordinal, request_id,"
                " window_number, status, started_at, streaming, input_count,"
                " parameters_digest, settings_digest, model_digest)"
                " VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)",
                (
                    agent_id,
                    sequence,
                    ordinal,
                    request_id,
                    window_number,
                    started,
                    int(streaming),
                    input_count,
                    *(value for value, _ in payloads),
                ),
            )
        return ModelRequestHandle(ordinal, request_id)

    def finish_model_request(
        self, agent_id: int, sequence: int, handle: ModelRequestHandle
    ) -> None:
        with self._db:
            row = first(
                self._db.execute(
                    "SELECT status FROM agent_model_requests WHERE agent_id = ?"
                    " AND sequence = ? AND ordinal = ? AND request_id = ?",
                    (agent_id, sequence, handle.ordinal, handle.request_id),
                )
            )
            if row is None:
                raise DomainError(ErrorCode.NOT_FOUND, "Model request does not exist")
            if row["status"] in ("responded", "completed"):
                return
            self._db.execute(
                "UPDATE agent_model_requests SET status = 'responded', completed_at = ?,"
                " error = NULL WHERE agent_id = ? AND sequence = ? AND ordinal = ?",
                (self._now(), agent_id, sequence, handle.ordinal),
            )

    def complete_model_request(
        self, agent_id: int, sequence: int, handle: ModelRequestHandle
    ) -> None:
        with self._db:
            cursor = self._db.execute_cursor(
                "UPDATE agent_model_requests SET status = 'completed'"
                " WHERE agent_id = ? AND sequence = ? AND ordinal = ? AND request_id = ?"
                " AND status IN ('responded', 'completed')",
                (agent_id, sequence, handle.ordinal, handle.request_id),
            )
            if cursor.rowcount != 1:
                raise DomainError(
                    ErrorCode.INVALID_STATE, "Model request has no successful response"
                )

    def fail_model_request(
        self,
        agent_id: int,
        sequence: int,
        handle: ModelRequestHandle,
        error: str,
    ) -> None:
        with self._db:
            cursor = self._db.execute_cursor(
                "UPDATE agent_model_requests SET status = 'failed', completed_at = ?,"
                " error = ? WHERE agent_id = ? AND sequence = ? AND ordinal = ?"
                " AND request_id = ?",
                (
                    self._now(),
                    error,
                    agent_id,
                    sequence,
                    handle.ordinal,
                    handle.request_id,
                ),
            )
            if cursor.rowcount != 1:
                raise DomainError(ErrorCode.NOT_FOUND, "Model request does not exist")

    @reading
    def last_saved_at(self, agent_id: int, sequence: int) -> str | None:
        row = first(
            self._db.execute(
                "SELECT last_saved_at FROM agent_runs WHERE agent_id = ? AND sequence = ?",
                (agent_id, sequence),
            )
        )
        return row["last_saved_at"] if row is not None else None

    @reading
    def window(self, agent_id: int) -> WindowState:
        row = first(
            self._db.execute(
                "SELECT number, since_sequence, reset_at, reason, overflow_context FROM agent_windows"
                " WHERE agent_id = ?",
                (agent_id,),
            )
        )
        if row is None:
            return WindowState(1, 1, None, None)
        return WindowState(
            int(row["number"]),
            int(row["since_sequence"]),
            row["reset_at"],
            row["reason"],
            row["overflow_context"],
        )

    def reset_window(
        self, agent_id: int, reason: str, overflow_context: str | None = None
    ) -> WindowState:
        if reason != "overflow":
            overflow_context = None
        if (
            overflow_context is not None
            and len(overflow_context.encode("utf-8")) > OVERFLOW_CONTEXT_BYTES
        ):
            raise ValueError("Overflow context exceeds its UTF-8 byte budget")
        current = self.window(agent_id)
        number = current.number + 1
        since_sequence_row = first(
            self._db.execute(
                "SELECT COALESCE(MAX(sequence), 0) + 1 AS v FROM agent_runs"
                " WHERE agent_id = ?",
                (agent_id,),
            )
        )
        assert since_sequence_row is not None
        since_sequence = int(since_sequence_row["v"])
        reset_at = self._now()
        with self._db:
            self._db.execute(
                "INSERT INTO agent_window_events"
                " (agent_id, number, since_sequence, reset_at, reason, overflow_context)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (agent_id, number, since_sequence, reset_at, reason, overflow_context),
            )
            self._db.execute(
                "INSERT INTO agent_windows (agent_id, number, since_sequence, reset_at, reason, overflow_context)"
                " VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET"
                " number = excluded.number, since_sequence = excluded.since_sequence,"
                " reset_at = excluded.reset_at, reason = excluded.reason,"
                " overflow_context = excluded.overflow_context",
                (agent_id, number, since_sequence, reset_at, reason, overflow_context),
            )
        return WindowState(number, since_sequence, reset_at, reason, overflow_context)

    @reading
    def window_content(self, agent_id: int, window_number: int) -> WindowContent:
        return WindowContent(
            tuple(
                str(row["content_json"])
                for row in self._db.execute(
                    "SELECT content_json FROM agent_messages WHERE agent_id = ?"
                    " AND window_number = ? ORDER BY position",
                    (agent_id, window_number),
                )
            )
        )

    @reading
    def current_content(self, agent_id: int) -> WindowContent:
        return self.window_content(agent_id, self.window(agent_id).number)

    @reading
    def read_run_slice(
        self, agent_id: int, sequence: int, offset: int | None, limit: int
    ) -> HistorySlice | None:
        run = first(
            self._db.execute(
                "SELECT sequence, status, started_at, last_saved_at FROM agent_runs"
                " WHERE agent_id = ? AND sequence = ?",
                (agent_id, sequence),
            )
        )
        if run is None:
            return None
        rows = self._db.execute(
            "SELECT position, char_length FROM agent_messages INDEXED BY agent_messages_run"
            " WHERE agent_id = ? AND sequence = ? ORDER BY position",
            (agent_id, sequence),
        )
        starts = []
        cursor = 1
        for row in rows:
            starts.append(cursor)
            cursor += int(row["char_length"]) + 1
        total_length = cursor if rows else 2
        start = max(total_length - limit, 0) if offset is None else offset
        if start > total_length:
            raise DomainError(
                ErrorCode.INVALID_OFFSET, "History offset exceeds its length"
            )
        end = min(start + limit, total_length)
        covered = [
            index
            for index, row in enumerate(rows)
            if starts[index] < end
            and starts[index] + int(row["char_length"]) + 1 > start
        ]
        if covered:
            contents = self._db.execute(
                "SELECT content_json FROM agent_messages INDEXED BY agent_messages_run"
                " WHERE agent_id = ? AND sequence = ? AND position BETWEEN ? AND ?"
                " ORDER BY position",
                (
                    agent_id,
                    sequence,
                    int(rows[covered[0]]["position"]),
                    int(rows[covered[-1]]["position"]),
                ),
            )
            text = ",".join(str(row["content_json"]) for row in contents)
            text += "]" if covered[-1] == len(rows) - 1 else ","
            text_start = starts[covered[0]]
            if covered[0] == 0:
                text = "[" + text
                text_start = 0
        else:
            text = "[]"
            text_start = 0
        return HistorySlice(
            sequence=int(run["sequence"]),
            status=str(run["status"]),
            started_at=str(run["started_at"]),
            messages=text[start - text_start : end - text_start],
            offset=start,
            total_length=total_length,
            last_saved_at=run["last_saved_at"],
        )

    @reading
    def runs(self, agent_id: int, *, limit: int = 50) -> tuple[AgentRun, ...]:
        rows = self._db.execute(
            "SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY sequence DESC LIMIT ?",
            (agent_id, limit),
        )
        return tuple(self._run(row) for row in rows)

    @reading
    def preparation_incomplete(self, agent_id: int) -> bool:
        row = first(
            self._db.execute(
                "SELECT status, reminded_json FROM agent_runs WHERE agent_id = ?"
                " AND sequence >= COALESCE((SELECT since_sequence FROM agent_windows"
                " WHERE agent_id = ?), 1) ORDER BY sequence DESC LIMIT 1",
                (agent_id, agent_id),
            )
        )
        return (
            row is not None
            and row["status"] != "completed"
            and row["reminded_json"] == "[]"
        )

    @reading
    def run_summaries(
        self, agent_id: int, *, limit: int = 50
    ) -> tuple[RunSummary, ...]:
        rows = self._db.execute(
            "SELECT sequence, status, started_at, completed_at, usage_json, error"
            " FROM agent_runs WHERE agent_id = ? ORDER BY sequence DESC LIMIT ?",
            (agent_id, limit),
        )
        return tuple(
            RunSummary(
                sequence=int(row["sequence"]),
                status=str(row["status"]),
                started_at=str(row["started_at"]),
                completed_at=row["completed_at"],
                usage_json=row["usage_json"],
                error=row["error"],
            )
            for row in rows
        )

    def record_effect(
        self, agent_id: int, sequence: int, tool: str, summary: str
    ) -> None:
        with self._db:
            row = first(
                self._db.execute(
                    "SELECT COALESCE(MAX(ordinal), 0) AS last FROM run_effects"
                    " WHERE agent_id = ? AND sequence = ?",
                    (agent_id, sequence),
                )
            )
            ordinal = (int(row["last"]) if row is not None else 0) + 1
            self._db.execute(
                "INSERT INTO run_effects (agent_id, sequence, ordinal, tool, summary,"
                " created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (agent_id, sequence, ordinal, tool, summary, self._now()),
            )

    @reading
    def effects(
        self, agent_id: int, *, sequences: Sequence[int] = ()
    ) -> tuple[TurnEffect, ...]:
        if sequences:
            placeholders = ",".join("?" for _ in sequences)
            rows = self._db.execute(
                "SELECT sequence, ordinal, tool, summary, created_at FROM run_effects"
                f" WHERE agent_id = ? AND sequence IN ({placeholders})"
                " ORDER BY sequence DESC, ordinal",
                (agent_id, *sequences),
            )
        else:
            rows = self._db.execute(
                "SELECT sequence, ordinal, tool, summary, created_at FROM run_effects"
                " WHERE agent_id = ? ORDER BY sequence DESC, ordinal",
                (agent_id,),
            )
        return tuple(
            TurnEffect(
                int(row["sequence"]),
                int(row["ordinal"]),
                str(row["tool"]),
                str(row["summary"]),
                str(row["created_at"]),
            )
            for row in rows
        )

    @reading
    def usage_total(self, agent_id: int) -> dict[str, int]:
        row = first(
            self._db.execute(
                "SELECT"
                " COALESCE(SUM(json_extract(usage_json, '$.input_tokens')), 0) AS input,"
                " COALESCE(SUM(json_extract(usage_json, '$.output_tokens')), 0) AS output,"
                " COALESCE(SUM(json_extract(usage_json, '$.cache_read_tokens')), 0) AS cached,"
                " COALESCE(SUM(json_extract(usage_json, '$.requests')), 0) AS requests"
                " FROM agent_runs WHERE agent_id = ? AND usage_json IS NOT NULL",
                (agent_id,),
            )
        )
        if row is None:
            return {
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "requests": 0,
                "total_tokens": 0,
            }
        stored = {
            "input_tokens": int(row["input"]),
            "output_tokens": int(row["output"]),
            "cache_read_tokens": int(row["cached"]),
            "requests": int(row["requests"]),
        }
        stored["total_tokens"] = stored["input_tokens"] + stored["output_tokens"]
        return stored

    def mark_interrupted(self) -> int:
        completed = self._now()
        with self._db:
            cursor = self._db.execute_cursor(
                "UPDATE agent_runs SET status = 'interrupted', completed_at = ?,"
                " last_saved_at = COALESCE(last_saved_at, ?) WHERE status = 'running'",
                (completed, completed),
            )
            self._db.execute(
                "UPDATE agent_model_requests SET status = 'interrupted', completed_at = ?"
                " WHERE status = 'pending'",
                (completed,),
            )
        return cursor.rowcount

    def mark_session_start(self) -> int:
        rows = self._db.execute(
            "SELECT agent_id, MAX(sequence) FROM agent_runs GROUP BY agent_id"
        )
        with self._db:
            self._db.executemany(
                "INSERT INTO agent_sessions (agent_id, start_after) VALUES (?, ?)"
                " ON CONFLICT (agent_id) DO UPDATE SET start_after = excluded.start_after",
                [(int(row[0]), int(row[1])) for row in rows],
            )
        return len(rows)

    @reading
    def search_runs(
        self, agent_id: int, query: str, *, limit: int = 20, offset: int = 0
    ) -> tuple[AgentRun, ...]:
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        rows = self._db.execute(
            "SELECT * FROM agent_runs r WHERE r.agent_id = ? AND r.status != 'running'"
            " AND EXISTS (SELECT 1 FROM agent_messages m INDEXED BY agent_messages_run"
            " WHERE m.agent_id = r.agent_id AND m.sequence = r.sequence"
            " AND m.content_json LIKE ? ESCAPE '\\')"
            " ORDER BY r.sequence DESC LIMIT ? OFFSET ?",
            (agent_id, f"%{escaped}%", limit, offset),
        )
        return tuple(self._run(row) for row in rows)

    @reading
    def get_settings(self, section: str) -> dict[str, object] | None:
        row = first(
            self._db.execute(
                "SELECT values_json FROM settings WHERE section = ?", (section,)
            )
        )
        if row is None:
            return None
        try:
            loaded = json.loads(str(row["values_json"]))
        except json.JSONDecodeError as error:
            raise DomainError(
                ErrorCode.INVALID_SETTING,
                f"Settings section {section} contains invalid JSON",
            ) from error
        if not isinstance(loaded, dict):
            raise DomainError(
                ErrorCode.INVALID_SETTING,
                f"Settings section {section} must be a JSON object",
            )
        return loaded

    def create_agent_with_model(
        self,
        name: str,
        model_config: object | None,
    ) -> dict[str, object]:
        name = validate_name(name)
        with self._db:
            catalog = ModelCatalog.restore(self.get_settings("model"))
            try:
                selection = AgentModelConfig.model_validate(
                    {} if model_config is None else model_config
                )
            except ValidationError:
                raise DomainError(
                    ErrorCode.INVALID_MODEL_CONFIG, "Invalid Agent model configuration"
                ) from None
            catalog.validate_selection(selection, "New Agent")
            if self._db.execute(
                "SELECT 1 FROM members WHERE name_key = ?", (name_key(name),)
            ):
                raise DomainError(
                    ErrorCode.DUPLICATE_NAME, "Member names must be unique"
                )
            member = create_member(self._db, "agent", name)
            catalog.agent_configs[str(member.id)] = selection
            self.set_settings("model", catalog.model_dump())
            return {"id": member.id, "name": member.name, "state": member.state}

    def delete_agent_with_model(self, agent_id: int) -> None:
        with self._db:
            delete_member(self._db, agent_id)
            values = self.get_settings("model") or {}
            selections = values.get("agent_configs")
            if isinstance(selections, dict):
                selections.pop(str(agent_id), None)
            self.set_settings("model", values)

    def model_catalog(self) -> dict[str, object]:
        catalog = ModelCatalog.restore(self.get_settings("model"))
        return {
            "models": [
                {
                    "id": model.id,
                    "name": model.name,
                    "enabled": catalog.provider(model.provider_id).enabled,
                    "thinking_options": thinking_options(
                        catalog.provider(model.provider_id).api_type,
                        model.model,
                        model.thinking_budget_tokens,
                    ),
                    "thinking_budget_tokens": model.thinking_budget_tokens,
                }
                for model in catalog.models
            ],
            "default_model_id": catalog.default_model_id,
            "default_thinking": catalog.default_thinking,
        }

    def agent_model_selection(self, agent_id: int) -> dict[str, object]:
        catalog = ModelCatalog.restore(self.get_settings("model"))
        saved = catalog.agent_configs.get(str(agent_id), AgentModelConfig())
        model_id, thinking = catalog.selection(agent_id)
        return {
            "agent_id": agent_id,
            "model_config": saved.model_dump(),
            "effective": {"model_id": model_id, "thinking": thinking},
        }

    def update_settings(
        self,
        section: str,
        values: dict[str, object],
    ) -> dict[str, object]:
        with self._db:
            stored = self.get_settings(section)
            if section == "model":
                agent_ids = {
                    int(row["id"])
                    for row in self._db.execute(
                        "SELECT id FROM members WHERE type = 'agent' AND deleted = 0"
                    )
                }
                updated = (
                    ModelCatalog.restore(stored).apply(values, agent_ids).model_dump()
                )
            else:
                updated = {**(stored or {}), **values}
                if section == "agent":
                    validate_parameters(values)
                    validate_parameters(updated)
                elif section == "voice":
                    if values.keys() - {"address", "model", "api_key"}:
                        raise DomainError(
                            ErrorCode.VOICE_CONFIG, "Unknown voice setting"
                        )
                    model = values.get("model")
                    if "model" in values and (
                        not isinstance(model, str) or not model.strip()
                    ):
                        raise DomainError(
                            ErrorCode.VOICE_CONFIG, "A transcription model is required"
                        )
                    updated = asdict(VoiceConfig.restore(updated))
            self.set_settings(section, updated)
            return updated

    def set_settings(self, section: str, values: dict[str, object]) -> None:
        with self._db:
            self._db.execute(
                "INSERT INTO settings (section, values_json) VALUES (?, ?)"
                " ON CONFLICT (section) DO UPDATE SET values_json = excluded.values_json",
                (section, json.dumps(values, ensure_ascii=False, sort_keys=True)),
            )
