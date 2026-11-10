from __future__ import annotations

from dataclasses import dataclass

from fora.core.actions import WORKSPACE_READ
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.core.permissions import Node, Permissions, render, within
from fora.ports.permissions import PermissionStore


@dataclass(frozen=True)
class Actor:
    member_id: int
    is_agent: bool


class Authorizer:
    def __init__(self, store: PermissionStore | None = None) -> None:
        self._store = store

    @property
    def store(self) -> PermissionStore | None:
        return self._store

    def permissions(self) -> Permissions | None:
        return self._store.permissions() if self._store is not None else None

    def allows(self, actor: Actor, node: Node) -> bool:
        permissions = self.permissions()
        if permissions is None:
            return True
        if within(node, (*WORKSPACE_READ, str(actor.member_id))):
            return True
        return permissions.allows(actor.member_id, node)

    def check(self, actor: Actor, node: Node) -> None:
        if not self.allows(actor, node):
            raise DomainError(
                ErrorCode.NOT_PERMITTED,
                f"{render(node)} is not permitted for this Member",
            )
