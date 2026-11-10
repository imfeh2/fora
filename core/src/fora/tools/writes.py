from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from fora.core.actions import FILES_WRITE, LIBRARY_WRITE
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.core.permissions import Node, Permissions


@dataclass(frozen=True)
class WritePlan:
    writable: tuple[Path, ...]
    protected: tuple[Path, ...]


def relative_parts(path: str | None) -> tuple[str, ...]:
    if path is None:
        return ()
    parts = tuple(
        part for part in PurePosixPath(path.replace("\\", "/")).parts if part != "/"
    )
    if any(part in (".", "..") for part in parts):
        raise DomainError(
            ErrorCode.INVALID_PATH, "Paths cannot contain . or .. segments"
        )
    return parts


def path_node(path: Path) -> Node:
    anchor, *rest = path.parts
    head = anchor.rstrip("\\/")
    return (head, *rest) if head else tuple(rest)


def node_path(node: Node, template: Path) -> Path:
    anchor = template.anchor
    if anchor in ("/", "\\") or not node:
        return Path(anchor, *node)
    return Path(node[0] + anchor[len(node[0]) :], *node[1:])


@dataclass(frozen=True)
class WriteScope:
    roots: tuple[Path, ...]
    library: Path
    workspaces: Path
    own: Path

    def writable(
        self, permissions: Permissions | None, member_id: int, path: Path
    ) -> bool:
        if path == self.own or path.is_relative_to(self.own):
            return True
        if path == self.library or path.is_relative_to(self.library):
            if permissions is None:
                return True
            return permissions.allows(
                member_id,
                (*LIBRARY_WRITE, *path.relative_to(self.library).parts),
            )
        if path == self.workspaces or path.is_relative_to(self.workspaces):
            return False
        if not any(path == root or path.is_relative_to(root) for root in self.roots):
            return False
        if permissions is None:
            return True
        return permissions.allows(member_id, (*FILES_WRITE, *path_node(path)))

    def plan(self, permissions: Permissions | None, member_id: int) -> WritePlan:
        candidates: set[Path] = {*self.roots, self.library, self.workspaces, self.own}
        if permissions is not None:
            candidates.update(
                node_path(node[len(FILES_WRITE) :], self.own)
                for node in permissions.boundaries(member_id, FILES_WRITE)
                if len(node) > len(FILES_WRITE)
            )
            candidates.update(
                self.library.joinpath(*node[len(LIBRARY_WRITE) :])
                for node in permissions.boundaries(member_id, LIBRARY_WRITE)
                if len(node) > len(LIBRARY_WRITE)
            )
        states: dict[Path, bool] = {}
        changes: list[tuple[Path, bool]] = []
        for path in sorted(candidates, key=lambda item: (len(item.parts), str(item))):
            state = self.writable(permissions, member_id, path)
            inherited = _inherited(states, path)
            states[path] = state
            if state != inherited:
                changes.append((path, state))
        return WritePlan(
            tuple(path for path, state in changes if state),
            tuple(path for path, state in changes if not state),
        )


def _inherited(states: dict[Path, bool], path: Path) -> bool:
    for ancestor in path.parents:
        if ancestor in states:
            return states[ancestor]
    return False


def require_existing(paths: Sequence[Path], exists: Callable[[Path], bool]) -> None:
    missing = [str(path) for path in paths if not exists(path)]
    if missing:
        raise DomainError(
            ErrorCode.SANDBOX_UNAVAILABLE,
            "Protected paths must exist before commands can run, so they cannot be "
            f"created around the protection: {', '.join(missing)}",
        )
