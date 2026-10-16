from __future__ import annotations

import codecs
import sqlite3
import uuid

from fora.adapters.sqlite.store import LockedConnection, first, now, reading
from fora.core.discussion import Message
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.ports.agent import (
    DiscussionPreview,
    GenerationKey,
    GenerationMutation,
    GenerationPart,
    GenerationTextPage,
    GenerationUpdate,
)

SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS agent_generation_parts (
        agent_id INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        part_index INTEGER NOT NULL CHECK (part_index >= 0),
        request_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        part_kind TEXT NOT NULL,
        content_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL CHECK (status IN ('generating', 'completed', 'failed', 'interrupted')),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        history_reference TEXT,
        PRIMARY KEY (agent_id, sequence, ordinal, part_index),
        FOREIGN KEY (agent_id, sequence, ordinal) REFERENCES agent_model_requests(agent_id, sequence, ordinal)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS discussion_previews (
        preview_id TEXT PRIMARY KEY,
        agent_id INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        part_index INTEGER NOT NULL,
        discussion_id INTEGER REFERENCES discussions(id),
        body TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL CHECK (status IN ('generating', 'sending', 'sent', 'failed', 'interrupted')),
        error TEXT,
        message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, sequence, ordinal, part_index),
        UNIQUE (discussion_id, message_id),
        FOREIGN KEY (agent_id, sequence, ordinal, part_index)
            REFERENCES agent_generation_parts(agent_id, sequence, ordinal, part_index),
        FOREIGN KEY (discussion_id, message_id) REFERENCES messages(discussion_id, id),
        CHECK ((status = 'sent' AND message_id IS NOT NULL) OR (status != 'sent' AND message_id IS NULL))
    )
    """,
    "CREATE INDEX IF NOT EXISTS discussion_previews_page ON discussion_previews(discussion_id, created_at, preview_id)",
)

PART_COLUMNS = "agent_id, sequence, ordinal, part_index, request_id, run_id, part_kind, revision, status, error, created_at, updated_at, json_extract(content_json, '$.tool_name') AS tool_name, json_extract(content_json, '$.tool_call_id') AS tool_call_id"
PREVIEW_COLUMNS = "p.preview_id, p.discussion_id, p.revision, p.status, p.error, p.message_id, p.created_at, p.updated_at, g.agent_id, g.sequence, g.ordinal, g.part_index, g.request_id, g.run_id"
KEY_WHERE = "agent_id = ? AND sequence = ? AND ordinal = ? AND part_index = ?"
TEXT_FIELDS = {
    "json": "content_json",
    "content": "json_extract(content_json, '$.content')",
    "args": "json_extract(content_json, '$.args')",
}


def key_values(key: GenerationKey) -> tuple[int, int, int, int]:
    values = (key.agent_id, key.sequence, key.ordinal, key.part_index)
    if (
        any(type(value) is not int for value in values)
        or min(values[:3]) < 1
        or values[3] < 0
    ):
        raise DomainError(ErrorCode.INVALID_GENERATION, "Invalid generation identity")
    return values


def row_key(row: sqlite3.Row) -> GenerationKey:
    return GenerationKey(
        row["agent_id"],
        row["sequence"],
        row["ordinal"],
        row["part_index"],
        row["request_id"],
        row["run_id"],
    )


def part_value(row: sqlite3.Row) -> GenerationPart:
    if any(
        row[field] is not None and not isinstance(row[field], str)
        for field in ("tool_name", "tool_call_id")
    ):
        raise DomainError(ErrorCode.INVALID_GENERATION, "Tool identity must be text")
    return GenerationPart(
        row_key(row),
        row["part_kind"],
        row["revision"],
        row["status"],
        row["error"],
        row["created_at"],
        row["updated_at"],
        row["tool_name"],
        row["tool_call_id"],
    )


def preview_value(row: sqlite3.Row) -> DiscussionPreview:
    return DiscussionPreview(
        row["preview_id"],
        row_key(row),
        row["discussion_id"],
        row["revision"],
        row["status"],
        row["error"],
        row["message_id"],
        row["created_at"],
        row["updated_at"],
    )


def text_bounds(revision: int, offset: int, limit: int) -> None:
    if type(revision) is not int or revision < 1:
        raise DomainError(ErrorCode.INVALID_PAGINATION, "Invalid generation revision")
    if (
        type(offset) is not int
        or offset < 0
        or type(limit) is not int
        or not 1 <= limit <= 65536
    ):
        raise DomainError(
            ErrorCode.INVALID_PAGINATION, "Invalid generation text bounds"
        )


def text_page(
    value: bytes, total_bytes: int, revision: int, offset: int, limit: int
) -> GenerationTextPage:
    text_bounds(revision, offset, limit)
    if offset > total_bytes:
        raise DomainError(
            ErrorCode.INVALID_PAGINATION, "Text offset exceeds content length"
        )
    end = offset + len(value)
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    try:
        content = decoder.decode(value, final=end == total_bytes)
        end -= len(decoder.getstate()[0])
    except UnicodeDecodeError as error:
        raise DomainError(
            ErrorCode.INVALID_PAGINATION, "Text offset must be a UTF-8 boundary"
        ) from error
    if end == offset and offset < total_bytes:
        raise DomainError(
            ErrorCode.INVALID_PAGINATION, "Text limit must include a complete character"
        )
    return GenerationTextPage(
        revision, offset, end, total_bytes, content, end < total_bytes
    )


def initialize_generation(db: LockedConnection) -> None:
    with db:
        for statement in SCHEMA:
            db.execute(statement)


class SqliteGenerationStore:
    def __init__(self, db: LockedConnection) -> None:
        self._db = db

    def _require_request(self, key: GenerationKey) -> sqlite3.Row:
        key_values(key)
        row = first(
            self._db.execute(
                "SELECT status FROM agent_model_requests WHERE agent_id = ? AND sequence = ? AND ordinal = ? AND request_id = ? AND run_id = ?",
                (key.agent_id, key.sequence, key.ordinal, key.request_id, key.run_id),
            )
        )
        if row is None:
            raise DomainError(
                ErrorCode.NOT_FOUND, "Model request identity does not exist"
            )
        return row

    def _part(self, key: GenerationKey) -> sqlite3.Row | None:
        return first(
            self._db.execute(
                f"SELECT {PART_COLUMNS} FROM agent_generation_parts WHERE {KEY_WHERE}",
                key_values(key),
            )
        )

    def _preview(self, key: GenerationKey) -> sqlite3.Row | None:
        return first(
            self._db.execute(
                f"SELECT {PREVIEW_COLUMNS} FROM discussion_previews p JOIN agent_generation_parts g USING (agent_id, sequence, ordinal, part_index) WHERE g.agent_id = ? AND g.sequence = ? AND g.ordinal = ? AND g.part_index = ?",
                key_values(key),
            )
        )

    def _sender_allowed(self, discussion_id: int, agent_id: int) -> bool:
        return bool(
            self._db.execute(
                "SELECT 1 FROM discussion_members dm JOIN members m ON m.id = dm.member_id JOIN discussions d ON d.id = dm.discussion_id WHERE dm.discussion_id = ? AND dm.member_id = ? AND m.deleted = 0 AND m.type = 'agent'",
                (discussion_id, agent_id),
            )
        )

    def save(self, key: GenerationKey, update: GenerationUpdate) -> GenerationMutation:
        if (
            update.status not in ("generating", "completed", "failed", "interrupted")
            or not update.part_kind
        ):
            raise DomainError(ErrorCode.INVALID_GENERATION, "Invalid generation state")
        with self._db:
            request = self._require_request(key)
            previous = self._part(key)
            old_preview = self._preview(key)
            old_target = (
                old_preview["discussion_id"] if old_preview is not None else None
            )
            if (
                previous is None
                and update.status == "generating"
                and request["status"] != "pending"
            ):
                raise DomainError(
                    ErrorCode.GENERATION_CLOSED, "Model request is already closed"
                )
            if previous is not None and (
                previous["status"] in ("failed", "interrupted")
                or (
                    update.status == "generating"
                    and (
                        (previous["status"] == "completed" and not update.replace_part)
                        or request["status"] != "pending"
                    )
                )
            ):
                return GenerationMutation(
                    part_value(previous),
                    preview_value(old_preview) if old_preview is not None else None,
                )
            revision = int(previous["revision"]) + 1 if previous is not None else 1
            timestamp = now()
            self._db.execute(
                "INSERT INTO agent_generation_parts(agent_id, sequence, ordinal, part_index, request_id, run_id, part_kind, content_json, revision, status, error, created_at, updated_at, history_reference) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, sequence, ordinal, part_index) DO UPDATE SET part_kind=excluded.part_kind, content_json=excluded.content_json, revision=excluded.revision, status=excluded.status, error=excluded.error, updated_at=excluded.updated_at, history_reference=COALESCE(excluded.history_reference, agent_generation_parts.history_reference)",
                (
                    *key_values(key),
                    key.request_id,
                    key.run_id,
                    update.part_kind,
                    update.content_json,
                    revision,
                    update.status,
                    update.error,
                    timestamp,
                    timestamp,
                    update.history_reference,
                ),
            )
            candidate = update.preview
            if candidate is not None and (
                type(candidate.discussion_id) is not int
                or candidate.discussion_id <= 0
                or not isinstance(candidate.body, str)
            ):
                raise DomainError(
                    ErrorCode.INVALID_GENERATION, "Invalid preview candidate"
                )
            allowed = candidate is not None and self._sender_allowed(
                candidate.discussion_id, key.agent_id
            )
            target = (
                candidate.discussion_id if candidate is not None and allowed else None
            )
            status = "sending" if update.status == "completed" else update.status
            error = update.error or update.preview_error
            if old_preview is not None and old_preview["status"] == "sent":
                return GenerationMutation(self.part(key), preview_value(old_preview))
            if target is not None or old_preview is not None:
                if (
                    (
                        update.status in ("failed", "interrupted")
                        or update.preview_error is not None
                    )
                    and not update.replace_part
                    and candidate is None
                    and old_target is not None
                    and self._sender_allowed(old_target, key.agent_id)
                ):
                    target = old_target
                if error is not None and update.status in ("generating", "completed"):
                    status = "failed"
                if old_preview is None:
                    assert candidate is not None
                    self._db.execute(
                        "INSERT INTO discussion_previews(preview_id, agent_id, sequence, ordinal, part_index, discussion_id, body, revision, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            uuid.uuid4().hex,
                            *key_values(key),
                            target,
                            candidate.body,
                            revision,
                            status,
                            error,
                            timestamp,
                            timestamp,
                        ),
                    )
                else:
                    self._db.execute(
                        "UPDATE discussion_previews SET discussion_id = ?, body = COALESCE(?, body), revision = ?, status = ?, error = ?, updated_at = ? WHERE preview_id = ?",
                        (
                            target,
                            candidate.body
                            if candidate is not None and allowed
                            else None,
                            revision,
                            status,
                            error,
                            timestamp,
                            old_preview["preview_id"],
                        ),
                    )
            return GenerationMutation(self.part(key), self.preview(key), old_target)

    @reading
    def part(self, key: GenerationKey) -> GenerationPart:
        self._require_request(key)
        row = self._part(key)
        if row is None:
            raise DomainError(ErrorCode.NOT_FOUND, "Generation part does not exist")
        return part_value(row)

    @reading
    def parts(
        self,
        agent_id: int,
        sequence: int,
        ordinal: int,
        *,
        after: int = -1,
        limit: int = 100,
    ) -> tuple[GenerationPart, ...]:
        if (
            type(limit) is not int
            or not 1 <= limit <= 100
            or type(after) is not int
            or after < -1
        ):
            raise DomainError(
                ErrorCode.INVALID_PAGINATION, "Invalid generation part bounds"
            )
        if not self._db.execute(
            "SELECT 1 FROM agent_model_requests WHERE agent_id = ? AND sequence = ? AND ordinal = ?",
            (agent_id, sequence, ordinal),
        ):
            raise DomainError(ErrorCode.NOT_FOUND, "Model request does not exist")
        return tuple(
            part_value(row)
            for row in self._db.execute(
                f"SELECT {PART_COLUMNS} FROM agent_generation_parts WHERE agent_id = ? AND sequence = ? AND ordinal = ? AND part_index > ? ORDER BY part_index LIMIT ?",
                (agent_id, sequence, ordinal, after, limit),
            )
        )

    @reading
    def preview(self, key: GenerationKey) -> DiscussionPreview | None:
        self._require_request(key)
        row = self._preview(key)
        return preview_value(row) if row is not None else None

    def _reader_allowed(self, discussion_id: int, member_id: int) -> None:
        if not self._db.execute(
            "SELECT 1 FROM discussion_members dm JOIN members m ON m.id = dm.member_id WHERE dm.discussion_id = ? AND dm.member_id = ? AND m.deleted = 0",
            (discussion_id, member_id),
        ):
            raise DomainError(
                ErrorCode.NOT_A_MEMBER, "You do not belong to this Discussion"
            )

    @reading
    def previews(
        self,
        discussion_id: int,
        member_id: int,
        *,
        before: tuple[str, str] | None = None,
        limit: int = 30,
        include_sent: bool = False,
    ) -> tuple[DiscussionPreview, ...]:
        if type(limit) is not int or not 1 <= limit <= 100:
            raise DomainError(
                ErrorCode.INVALID_PAGINATION, "Preview limit must be from 1 to 100"
            )
        self._reader_allowed(discussion_id, member_id)
        parameters: list[object] = [discussion_id]
        condition = ""
        if before is not None:
            condition = " AND (p.created_at, p.preview_id) < (?, ?)"
            parameters.extend(before)
        parameters.append(limit)
        if not include_sent:
            condition += " AND p.status != 'sent'"
        return tuple(
            preview_value(row)
            for row in self._db.execute(
                f"SELECT {PREVIEW_COLUMNS} FROM discussion_previews p JOIN agent_generation_parts g USING (agent_id, sequence, ordinal, part_index) LEFT JOIN discussion_members dm ON dm.discussion_id = p.discussion_id AND dm.member_id = p.agent_id JOIN members m ON m.id = p.agent_id WHERE p.discussion_id = ? AND (p.status = 'sent' OR (dm.member_id IS NOT NULL AND m.deleted = 0))"
                + condition
                + " ORDER BY p.created_at DESC, p.preview_id DESC LIMIT ?",
                parameters,
            )
        )

    @reading
    def visible_preview(
        self, preview_id: str, discussion_id: int, member_id: int
    ) -> DiscussionPreview:
        self._reader_allowed(discussion_id, member_id)
        row = first(
            self._db.execute(
                f"SELECT {PREVIEW_COLUMNS} FROM discussion_previews p JOIN agent_generation_parts g USING (agent_id, sequence, ordinal, part_index) LEFT JOIN discussion_members dm ON dm.discussion_id = p.discussion_id AND dm.member_id = p.agent_id JOIN members m ON m.id = p.agent_id WHERE p.preview_id = ? AND p.discussion_id = ? AND (p.status = 'sent' OR (dm.member_id IS NOT NULL AND m.deleted = 0))",
                (preview_id, discussion_id),
            )
        )
        if row is None:
            raise DomainError(
                ErrorCode.NOT_FOUND, "Preview is not visible in this Discussion"
            )
        return preview_value(row)

    @reading
    def part_text(
        self,
        key: GenerationKey,
        revision: int,
        offset: int = 0,
        limit: int = 16384,
        *,
        field: str = "json",
    ) -> GenerationTextPage:
        text_bounds(revision, offset, limit)
        if not isinstance(field, str) or field not in TEXT_FIELDS:
            raise DomainError(ErrorCode.INVALID_PARAMS, "Generation field is invalid")
        expression = TEXT_FIELDS[field]
        part = self.part(key)
        if part.revision != revision:
            raise DomainError(
                ErrorCode.GENERATION_CHANGED, "Generation content revision changed"
            )
        row = first(
            self._db.execute(
                f"SELECT substr(CAST({expression} AS BLOB), ?, ?) AS content, length(CAST({expression} AS BLOB)) AS total_bytes FROM agent_generation_parts WHERE {KEY_WHERE}",
                (offset + 1, limit, *key_values(key)),
            )
        )
        assert row is not None
        if row["content"] is None:
            raise DomainError(ErrorCode.NOT_FOUND, "Generation field does not exist")
        return text_page(
            row["content"], row["total_bytes"], part.revision, offset, limit
        )

    @reading
    def preview_text(
        self,
        preview_id: str,
        discussion_id: int,
        member_id: int,
        revision: int,
        offset: int = 0,
        limit: int = 16384,
    ) -> GenerationTextPage:
        text_bounds(revision, offset, limit)
        self._reader_allowed(discussion_id, member_id)
        row = first(
            self._db.execute(
                "SELECT substr(CAST(p.body AS BLOB), ?, ?) AS content, length(CAST(p.body AS BLOB)) AS total_bytes, p.revision FROM discussion_previews p LEFT JOIN discussion_members dm ON dm.discussion_id = p.discussion_id AND dm.member_id = p.agent_id JOIN members m ON m.id = p.agent_id WHERE p.preview_id = ? AND p.discussion_id = ? AND (p.status = 'sent' OR (dm.member_id IS NOT NULL AND m.deleted = 0))",
                (offset + 1, limit, preview_id, discussion_id),
            )
        )
        if row is None:
            raise DomainError(
                ErrorCode.NOT_FOUND, "Preview is not visible in this Discussion"
            )
        if row["revision"] != revision:
            raise DomainError(
                ErrorCode.GENERATION_CHANGED, "Preview content revision changed"
            )
        return text_page(row["content"], row["total_bytes"], revision, offset, limit)

    def link(self, key: GenerationKey, message: Message) -> DiscussionPreview:
        with self._db:
            self.part(key)
            row = self._preview(key)
            if row is None:
                raise DomainError(ErrorCode.NOT_FOUND, "Preview does not exist")
            if message.sender_id != key.agent_id:
                raise DomainError(
                    ErrorCode.INVALID_GENERATION,
                    "Message sender differs from preview sender",
                )
            if row["status"] == "sent":
                if (row["discussion_id"], row["message_id"]) != (
                    message.discussion_id,
                    message.id,
                ):
                    raise DomainError(
                        ErrorCode.MESSAGE_CONFLICT,
                        "Preview already belongs to another message",
                    )
                return preview_value(row)
            self._db.execute(
                "UPDATE discussion_previews SET discussion_id = ?, message_id = ?, body = ?, revision = revision + 1, status = 'sent', error = NULL, updated_at = ? WHERE preview_id = ?",
                (
                    message.discussion_id,
                    message.id,
                    message.body,
                    now(),
                    row["preview_id"],
                ),
            )
            value = self.preview(key)
            assert value is not None
            return value

    def interrupt(
        self,
        *,
        agent_id: int | None = None,
        sequence: int | None = None,
        error: str = "Generation interrupted",
    ) -> int:
        with self._db:
            condition = ""
            parameters: list[object] = [error, now()]
            if agent_id is not None:
                condition += " AND agent_id = ?"
                parameters.append(agent_id)
            if sequence is not None:
                condition += " AND sequence = ?"
                parameters.append(sequence)
            changed = self._db.execute_cursor(
                "UPDATE agent_generation_parts SET status = 'interrupted', error = ?, updated_at = ?, revision = revision + 1 WHERE status = 'generating'"
                + condition,
                parameters,
            ).rowcount
            self._db.execute(
                "UPDATE discussion_previews SET status = 'interrupted', error = ?, updated_at = ?, revision = revision + 1 WHERE status IN ('generating', 'sending')"
                + condition,
                parameters,
            )
            return changed
