from __future__ import annotations

from collections.abc import Sequence
from contextlib import AbstractContextManager
from typing import Protocol

from fora.core.permissions import Entry, Grant, Permissions


class PermissionStore(Protocol):
    def transaction(self) -> AbstractContextManager[object]: ...

    def owner_id(self) -> int | None: ...

    def set_owner(self, member_id: int) -> None: ...

    def permissions(self) -> Permissions: ...

    def add_grant(
        self,
        holder_id: int,
        granted_by: int,
        parent_id: int | None,
        entries: Sequence[Entry],
    ) -> Grant: ...

    def revoke_grant(self, grant_id: int, revoked_by: int) -> Grant: ...

    def revoke_held(self, holder_id: int, revoked_by: int) -> int: ...
