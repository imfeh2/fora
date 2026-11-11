from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

from fora.core.actions import FILES_READ, FILES_WRITE, LIBRARY_WRITE, WORKSPACE_READ
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.core.permissions import Node
from fora.ports.execution import Access, Mount, Sandbox
from fora.tools.authorize import Rights

WORKSPACE = "workspace"


def _real_name(directory: Path, name: str) -> str:
    other = name.swapcase()
    if (
        other == name
        or not os.path.lexists(directory / name)
        or not os.path.lexists(directory / other)
    ):
        return name
    entry = os.lstat(directory / name)
    if not os.path.samestat(entry, os.lstat(directory / other)):
        return name
    return next(
        item
        for item in os.listdir(directory)
        if item.casefold() == name.casefold()
        and os.path.samestat(os.lstat(directory / item), entry)
    )


def real_path(path: Path, *, follow_symlinks: bool = True) -> Path:
    if not follow_symlinks and path.parent != path:
        parent = real_path(path.parent)
        return parent / _real_name(parent, path.name)
    resolved = path.resolve()
    current = Path(resolved.anchor)
    for part in resolved.parts[1:]:
        current = current / _real_name(current, part)
    return current


def real_node(node: Node, action: Node, template: Path) -> Node:
    if len(node) <= len(action):
        return node
    return (*action, *path_node(real_path(node_path(node[len(action) :], template))))


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
class Layout:
    library: Path
    agents: Path | None
    own: Path | None = None
    workspace: Path | None = None
    data: Path | None = None
    uploads: Path | None = None
    discussions: tuple[Path, ...] = ()
    links: tuple[tuple[Path, str], ...] = ()


@dataclass(frozen=True)
class FileAccess:
    layout: Layout
    rights: Rights
    _cache: dict[Path, Access] = field(default_factory=dict, compare=False)

    def _allows(self, node: Node) -> bool:
        return self.rights.allows(node)

    def label(self, path: Path) -> str | None:
        layout = self.layout
        if layout.workspace is not None and path.is_relative_to(layout.workspace):
            return "your workspace, private"
        if path.is_relative_to(layout.library):
            return "Library, shared with the whole organization"
        return None

    def access(self, path: Path) -> Access:
        if path not in self._cache:
            self._cache[path] = self._decide(path)
        return self._cache[path]

    def _decide(self, path: Path) -> Access:
        layout = self.layout
        if layout.workspace is not None and path.is_relative_to(layout.workspace):
            return Access.WRITE
        if path.is_relative_to(layout.library):
            relative = path.relative_to(layout.library).parts
            if self._allows((*LIBRARY_WRITE, *relative)):
                return Access.WRITE
            return Access.READ
        if layout.own is not None and path.is_relative_to(layout.own):
            return Access.READ
        if layout.agents is not None and path.is_relative_to(layout.agents):
            if path == layout.agents:
                return Access.HIDDEN
            member, *rest = path.relative_to(layout.agents).parts
            if rest[:1] == [WORKSPACE] and self._allows(
                (*WORKSPACE_READ, member, *rest[1:])
            ):
                return Access.READ
            return Access.HIDDEN
        if layout.uploads is not None and path.is_relative_to(layout.uploads):
            if any(path.is_relative_to(item) for item in layout.discussions):
                return Access.READ
            return Access.HIDDEN
        if layout.data is not None and path.is_relative_to(layout.data):
            return Access.HIDDEN
        node = path_node(path)
        if self._allows((*FILES_WRITE, *node)):
            return Access.WRITE
        if self._allows((*FILES_READ, *node)) or any(
            self._allows((*FILES_WRITE, *node[:depth])) for depth in range(len(node))
        ):
            return Access.READ
        return Access.HIDDEN

    def require(
        self, path: Path, needed: Access, *, whole: bool = False, shown: str = ""
    ) -> None:
        verb = "Writing" if needed is Access.WRITE else "Reading"
        name = shown or str(path)
        if self.access(path) < needed:
            raise DomainError(
                ErrorCode.NOT_PERMITTED,
                f"{verb} {name} is not permitted for this Member",
            )
        if whole and any(
            mount.access < needed
            and mount.path != path
            and mount.path.is_relative_to(path)
            for mount in self.sandbox.mounts
        ):
            raise DomainError(
                ErrorCode.NOT_PERMITTED,
                f"{verb} everything inside {name} is not permitted for this Member",
            )

    def _candidates(self) -> set[Path]:
        layout = self.layout
        found = {layout.library, *layout.discussions}
        found.update(
            item
            for item in (
                layout.agents,
                layout.own,
                layout.workspace,
                layout.data,
                layout.uploads,
            )
            if item is not None
        )
        if layout.agents is not None and layout.agents.is_dir():
            for entry in layout.agents.iterdir():
                found.update((entry, entry / WORKSPACE))
        permissions = self.rights.permissions
        if permissions is None:
            return found
        member_id = self.rights.actor.member_id
        for action in (FILES_WRITE, FILES_READ):
            found.update(
                node_path(node[len(action) :], layout.library)
                for node in permissions.boundaries(member_id, action)
                if len(node) > len(action)
            )
        found.update(
            layout.library.joinpath(*node[len(LIBRARY_WRITE) :])
            for node in permissions.boundaries(member_id, LIBRARY_WRITE)
            if len(node) > len(LIBRARY_WRITE)
        )
        if layout.agents is not None:
            for node in permissions.boundaries(member_id, WORKSPACE_READ):
                parts = node[len(WORKSPACE_READ) :]
                if parts:
                    found.add(layout.agents / parts[0])
                    found.add(layout.agents.joinpath(parts[0], WORKSPACE, *parts[1:]))
        return found

    @cached_property
    def sandbox(self) -> Sandbox:
        root = Path(self.layout.library.anchor)
        root_access = self.access(root)
        states: dict[Path, Access] = {root: root_access}
        mounts: list[Mount] = []
        candidates = {real_path(path) for path in self._candidates()}
        for path in sorted(
            candidates - {root},
            key=lambda item: (len(item.parts), str(item)),
        ):
            state = self.access(path)
            inherited = next(
                (states[parent] for parent in path.parents if parent in states),
                root_access,
            )
            states[path] = state
            if state != inherited:
                mounts.append(Mount(path, state))
        return Sandbox(root_access, tuple(mounts), self.layout.links, root)


def require_protected(sandbox: Sandbox) -> None:
    missing = [str(path) for path in sandbox.protected() if not path.exists()]
    if missing:
        raise DomainError(
            ErrorCode.SANDBOX_UNAVAILABLE,
            "Commands cannot run until these paths you may not change exist: "
            f"{', '.join(missing)}. Ask a Member who may write there to create them.",
        )
