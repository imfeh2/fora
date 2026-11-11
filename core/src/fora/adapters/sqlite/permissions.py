from __future__ import annotations

import json
import secrets
import sqlite3
from collections.abc import Sequence

from fora.adapters.sqlite.store import LockedConnection, first, now, reading
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.core.permissions import Entry, Grant, Permissions, parse_entries

SCHEMA = """
CREATE TABLE IF NOT EXISTS permission_owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    member_id INTEGER NOT NULL REFERENCES members(id)
);
CREATE TABLE IF NOT EXISTS permission_grants (
    id INTEGER PRIMARY KEY,
    holder_id INTEGER NOT NULL REFERENCES members(id),
    granted_by INTEGER NOT NULL REFERENCES members(id),
    parent_id INTEGER REFERENCES permission_grants(id),
    entries_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by INTEGER REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS permission_grants_holder
    ON permission_grants(holder_id);
CREATE TABLE IF NOT EXISTS permission_revision (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL
);
INSERT OR IGNORE INTO permission_revision (id, value) VALUES (1, 0);
"""


def grant_from_row(row: sqlite3.Row) -> Grant:
    return Grant(
        id=int(row["id"]),
        holder_id=int(row["holder_id"]),
        granted_by=int(row["granted_by"]),
        parent_id=int(row["parent_id"]) if row["parent_id"] is not None else None,
        entries=parse_entries(json.loads(row["entries_json"])),
        created_at=str(row["created_at"]),
        revoked_at=str(row["revoked_at"]) if row["revoked_at"] is not None else None,
    )


class SqlitePermissionStore:
    def __init__(self, db: LockedConnection) -> None:
        self._db = db
        self._db.executescript(SCHEMA)
        self._cached: tuple[int, Permissions] | None = None

    def transaction(self) -> LockedConnection:
        return self._db

    @reading
    def owner_id(self) -> int | None:
        row = first(self._db.execute("SELECT member_id FROM permission_owner"))
        return int(row["member_id"]) if row is not None else None

    def set_owner(self, member_id: int) -> None:
        with self._db:
            self._db.execute(
                "INSERT INTO permission_owner(id, member_id) VALUES (1, ?) "
                "ON CONFLICT(id) DO UPDATE SET member_id = excluded.member_id",
                (member_id,),
            )
            self._changed()

    @reading
    def permissions(self) -> Permissions:
        revision = int(self._db.execute("SELECT value FROM permission_revision")[0][0])
        cached = self._cached
        if cached is not None and cached[0] == revision:
            return cached[1]
        owner = self.owner_id()
        if owner is None:
            raise DomainError(
                ErrorCode.NOT_PERMITTED, "The organization has no owner yet"
            )
        rows = self._db.execute("SELECT * FROM permission_grants ORDER BY id")
        loaded = Permissions(owner, (grant_from_row(row) for row in rows))
        self._cached = (revision, loaded)
        return loaded

    def _changed(self) -> None:
        self._db.execute(
            "UPDATE permission_revision SET value = ?", (secrets.randbits(62),)
        )

    def add_grant(
        self,
        holder_id: int,
        granted_by: int,
        parent_id: int | None,
        entries: Sequence[Entry],
    ) -> Grant:
        with self._db:
            cursor = self._db.execute_cursor(
                "INSERT INTO permission_grants"
                "(holder_id, granted_by, parent_id, entries_json, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    holder_id,
                    granted_by,
                    parent_id,
                    json.dumps(
                        [entry.payload() for entry in entries], ensure_ascii=False
                    ),
                    now(),
                ),
            )
            self._changed()
            return self._grant(int(cursor.lastrowid or 0))

    def revoke_grant(self, grant_id: int, revoked_by: int) -> Grant:
        with self._db:
            self._db.execute(
                "UPDATE permission_grants SET revoked_at = ?, revoked_by = ? "
                "WHERE id = ? AND revoked_at IS NULL",
                (now(), revoked_by, grant_id),
            )
            self._changed()
            return self._grant(grant_id)

    def revoke_held(self, holder_id: int, revoked_by: int) -> int:
        with self._db:
            cursor = self._db.execute_cursor(
                "UPDATE permission_grants SET revoked_at = ?, revoked_by = ? "
                "WHERE holder_id = ? AND revoked_at IS NULL",
                (now(), revoked_by, holder_id),
            )
            self._changed()
            return cursor.rowcount

    def _grant(self, grant_id: int) -> Grant:
        row = first(
            self._db.execute(
                "SELECT * FROM permission_grants WHERE id = ?", (grant_id,)
            )
        )
        if row is None:
            raise DomainError(ErrorCode.NOT_FOUND, f"Grant {grant_id} does not exist")
        return grant_from_row(row)
