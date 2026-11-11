from __future__ import annotations

from dataclasses import dataclass

from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.core.permissions import Node, Permissions, render
from fora.ports.permissions import PermissionStore


@dataclass(frozen=True)
class Actor:
    member_id: int
    is_agent: bool


@dataclass(frozen=True)
class Rights:
    actor: Actor
    permissions: Permissions | None

    def allows(self, node: Node) -> bool:
        return self.permissions is None or self.permissions.allows(
            self.actor.member_id, node
        )

    def check(self, node: Node) -> None:
        if not self.allows(node):
            raise DomainError(
                ErrorCode.NOT_PERMITTED,
                f"{render(node)} is not permitted for this Member",
            )


class Authorizer:
    def __init__(self, store: PermissionStore | None = None) -> None:
        self._store = store

    @property
    def store(self) -> PermissionStore | None:
        return self._store

    def rights(self, actor: Actor) -> Rights:
        return Rights(
            actor, self._store.permissions() if self._store is not None else None
        )
