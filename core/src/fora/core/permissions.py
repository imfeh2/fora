from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError

type Node = tuple[str, ...]
type Sign = Literal["+", "-"]

ROOT: Node = ()
OWNER: Node = ("owner",)
SEPARATOR = ":"


@dataclass(frozen=True)
class Entry:
    sign: Sign
    node: Node
    delegable: bool = False

    def payload(self) -> dict[str, object]:
        return {"sign": self.sign, "node": list(self.node), "delegable": self.delegable}


@dataclass(frozen=True)
class Grant:
    id: int
    holder_id: int
    granted_by: int
    parent_id: int | None
    entries: tuple[Entry, ...]
    created_at: str
    revoked_at: str | None = None

    @property
    def active(self) -> bool:
        return self.revoked_at is None

    def payload(self) -> dict[str, object]:
        return {
            "id": self.id,
            "holder_id": self.holder_id,
            "granted_by": self.granted_by,
            "parent_id": self.parent_id,
            "entries": [entry.payload() for entry in self.entries],
            "lines": [render_entry(entry) for entry in self.entries],
            "created_at": self.created_at,
            "revoked_at": self.revoked_at,
        }


def within(node: Node, prefix: Node) -> bool:
    return node[: len(prefix)] == prefix


def render(node: Node) -> str:
    if not node:
        return "*"
    return SEPARATOR.join(
        f'"{part}"' if SEPARATOR in part or '"' in part or not part else part
        for part in node
    )


def render_entry(entry: Entry) -> str:
    suffix = " (delegable)" if entry.delegable else ""
    return f"{entry.sign} {render(entry.node)}{suffix}"


def entry_allows(entries: Iterable[Entry], node: Node, *, delegable: bool) -> bool:
    included = False
    for entry in entries:
        if not within(node, entry.node):
            continue
        if entry.sign == "-":
            return False
        if entry.delegable or not delegable:
            included = True
    return included


def parse_node(value: object) -> Node:
    if not isinstance(value, Sequence) or isinstance(value, str | bytes):
        raise DomainError(
            ErrorCode.INVALID_PERMISSION, "A permission node must be a list of parts"
        )
    parts = tuple(value)
    if not all(isinstance(part, str) and part for part in parts):
        raise DomainError(
            ErrorCode.INVALID_PERMISSION,
            "Every part of a permission node must be a non-empty string",
        )
    if any(part in (".", "..") for part in parts):
        raise DomainError(
            ErrorCode.INVALID_PERMISSION, "A permission node cannot contain . or .."
        )
    return parts


def parse_entries(value: object) -> tuple[Entry, ...]:
    if not isinstance(value, Sequence) or isinstance(value, str | bytes) or not value:
        raise DomainError(
            ErrorCode.INVALID_PERMISSION, "entries must be a non-empty list"
        )
    entries = []
    for item in value:
        if not isinstance(item, Mapping):
            raise DomainError(
                ErrorCode.INVALID_PERMISSION, "Every entry must be an object"
            )
        unknown = set(item) - {"sign", "node", "delegable"}
        if unknown:
            raise DomainError(
                ErrorCode.INVALID_PERMISSION,
                f"Unknown entry fields: {', '.join(sorted(map(str, unknown)))}",
            )
        sign = item.get("sign")
        if sign not in ("+", "-"):
            raise DomainError(ErrorCode.INVALID_PERMISSION, 'sign must be "+" or "-"')
        delegable = item.get("delegable", False)
        if type(delegable) is not bool:
            raise DomainError(
                ErrorCode.INVALID_PERMISSION, "delegable must be true or false"
            )
        if sign == "-" and delegable:
            raise DomainError(
                ErrorCode.INVALID_PERMISSION, "Only + entries can be delegable"
            )
        entries.append(Entry(sign, parse_node(item.get("node")), delegable))
    return validate_entries(entries)


def validate_entries(entries: Sequence[Entry]) -> tuple[Entry, ...]:
    included = [entry for entry in entries if entry.sign == "+"]
    if not included:
        raise DomainError(
            ErrorCode.INVALID_PERMISSION, "A grant needs at least one + entry"
        )
    for entry in included:
        for other in entries:
            if other.sign == "-" and within(entry.node, other.node):
                raise DomainError(
                    ErrorCode.INVALID_PERMISSION,
                    f"{render(entry.node)} is inside the excluded {render(other.node)}",
                )
    return tuple(entries)


class Permissions:
    def __init__(self, owner_id: int, grants: Iterable[Grant]) -> None:
        self.owner_id = owner_id
        self._grants = {grant.id: grant for grant in grants}
        # 快照不会变化，有效的授权在创建时按持有人整理好
        self._active = tuple(
            grant for grant in self._grants.values() if self._valid(grant)
        )
        self._held: dict[int, list[Grant]] = {}
        for grant in self._active:
            self._held.setdefault(grant.holder_id, []).append(grant)

    def active(self) -> tuple[Grant, ...]:
        return self._active

    def grants_of(self, member_id: int) -> tuple[Grant, ...]:
        return tuple(self._held.get(member_id, ()))

    def allows(self, member_id: int, node: Node) -> bool:
        if member_id == self.owner_id:
            return True
        if within(node, OWNER):
            return False
        return any(
            self._chain_allows(grant, node, delegable=False)
            for grant in self.grants_of(member_id)
        )

    def parent_for(self, granter_id: int, entries: Sequence[Entry]) -> int | None:
        included = [entry.node for entry in entries if entry.sign == "+"]
        if any(within(node, OWNER) for node in included):
            raise DomainError(
                ErrorCode.INVALID_PERMISSION,
                f"{render(OWNER)} stays with the owner and cannot be granted",
            )
        if granter_id == self.owner_id:
            return None
        for grant in self.grants_of(granter_id):
            if all(
                self._chain_allows(grant, node, delegable=True) for node in included
            ):
                return grant.id
        raise DomainError(
            ErrorCode.NOT_PERMITTED,
            "You can only grant what one of your own grants lets you delegate",
        )

    def can_revoke(self, member_id: int, grant_id: int) -> bool:
        if member_id == self.owner_id:
            return True
        grant = self._grants.get(grant_id)
        while grant is not None:
            if grant.granted_by == member_id:
                return True
            grant = (
                self._grants.get(grant.parent_id)
                if grant.parent_id is not None
                else None
            )
        return False

    def boundaries(self, member_id: int, action: Node) -> tuple[Node, ...]:
        found = {action}
        if member_id != self.owner_id:
            for grant in self.grants_of(member_id):
                for link in self._chain(grant):
                    for entry in link.entries:
                        if within(entry.node, action):
                            found.add(entry.node)
        return tuple(sorted(found, key=lambda node: (len(node), node)))

    def _chain(self, grant: Grant) -> list[Grant]:
        chain = [grant]
        while chain[-1].parent_id is not None:
            chain.append(self._grants[chain[-1].parent_id])
        return chain

    def _valid(self, grant: Grant) -> bool:
        current: Grant | None = grant
        while current is not None:
            if not current.active:
                return False
            if current.parent_id is None:
                return current.granted_by == self.owner_id
            parent = self._grants.get(current.parent_id)
            if parent is None or parent.holder_id != current.granted_by:
                return False
            current = parent
        return False

    def _chain_allows(self, grant: Grant, node: Node, *, delegable: bool) -> bool:
        if not entry_allows(grant.entries, node, delegable=delegable):
            return False
        if grant.parent_id is None:
            return True
        return self._chain_allows(self._grants[grant.parent_id], node, delegable=True)
