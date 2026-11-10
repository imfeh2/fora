from __future__ import annotations

from collections.abc import Callable
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

    def checker(self, actor: Actor) -> Callable[[Node], bool]:
        # 一次取出权限快照，逐个判定大量节点时不用每次都查询数据库
        permissions = self.permissions()
        own = (*WORKSPACE_READ, str(actor.member_id))

        def allows(node: Node) -> bool:
            if permissions is None or within(node, own):
                return True
            return permissions.allows(actor.member_id, node)

        return allows

    def allows(self, actor: Actor, node: Node) -> bool:
        return self.checker(actor)(node)

    def check(self, actor: Actor, node: Node) -> None:
        if not self.allows(actor, node):
            raise DomainError(
                ErrorCode.NOT_PERMITTED,
                f"{render(node)} is not permitted for this Member",
            )

    def check_within(self, actor: Actor, node: Node) -> None:
        permissions = self.permissions()
        if permissions is not None and not permissions.allows_within(
            actor.member_id, node
        ):
            raise DomainError(
                ErrorCode.NOT_PERMITTED,
                f"{render(node)} or something inside it is not permitted "
                "for this Member",
            )
