from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from fora.core.actions import FILES_READ, FILES_WRITE, LIBRARY_WRITE, WORKSPACE_READ
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.core.permissions import Node, Permissions
from fora.ports.execution import Access, Mount, Sandbox

WORKSPACE = "workspace"


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


def _real_name(directory: Path, name: str) -> str:
    # 只有在不区分大小写的目录里，换了大小写的名字才会指向同一个文件
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
        if os.path.samestat(os.lstat(directory / item), entry)
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


def tree_node(root: Path, path: str | None, *, follow_symlinks: bool = True) -> Node:
    parts = relative_parts(path)
    if not parts:
        return ()
    base = real_path(root)
    target = real_path(base.joinpath(*parts), follow_symlinks=follow_symlinks)
    if not target.is_relative_to(base):
        raise DomainError(ErrorCode.INVALID_PATH, "Path must stay inside the tree")
    return target.relative_to(base).parts


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
class AccessScope:
    writes: tuple[Path, ...]
    reads: tuple[Path, ...]
    library: Path
    own: Path
    workspace: Path
    member_id: int
    data: Path | None = None
    uploads: Path | None = None
    links: tuple[tuple[Path, str], ...] = ()

    @property
    def agents(self) -> Path:
        return self.own.parent

    def access(self, permissions: Permissions | None, path: Path) -> Access:
        def allows(node: Node) -> bool:
            return permissions is None or permissions.allows(self.member_id, node)

        if path.is_relative_to(self.workspace):
            return Access.WRITE
        if path.is_relative_to(self.library):
            relative = path.relative_to(self.library).parts
            return Access.WRITE if allows((*LIBRARY_WRITE, *relative)) else Access.READ
        if path.is_relative_to(self.own):
            return Access.READ
        if path != self.agents and path.is_relative_to(self.agents):
            member, *rest = path.relative_to(self.agents).parts
            if rest[:1] != [WORKSPACE]:
                return Access.HIDDEN
            return (
                Access.READ
                if allows((*WORKSPACE_READ, member, *rest[1:]))
                else Access.HIDDEN
            )
        if path.is_relative_to(self.agents):
            return Access.HIDDEN
        if self.uploads is not None and path.is_relative_to(self.uploads):
            return Access.READ
        if self.data is not None and path.is_relative_to(self.data):
            return Access.HIDDEN
        node = path_node(path)
        if any(path.is_relative_to(root) for root in self.writes) and allows(
            (*FILES_WRITE, *node)
        ):
            return Access.WRITE
        if any(path.is_relative_to(root) for root in self.reads) or allows(
            (*FILES_READ, *node)
        ):
            return Access.READ
        return Access.HIDDEN

    def _candidates(self, permissions: Permissions | None) -> set[Path]:
        found = {
            *self.writes,
            *self.reads,
            self.library,
            self.agents,
            self.own,
            self.workspace,
        }
        found.update(item for item in (self.data, self.uploads) if item is not None)
        if self.agents.is_dir():
            for entry in self.agents.iterdir():
                found.update((entry, entry / WORKSPACE))
        if permissions is None:
            return found
        for action in (FILES_WRITE, FILES_READ):
            found.update(
                node_path(node[len(action) :], self.library)
                for node in permissions.boundaries(self.member_id, action)
                if len(node) > len(action)
            )
        found.update(
            self.library.joinpath(*node[len(LIBRARY_WRITE) :])
            for node in permissions.boundaries(self.member_id, LIBRARY_WRITE)
            if len(node) > len(LIBRARY_WRITE)
        )
        for node in permissions.boundaries(self.member_id, WORKSPACE_READ):
            parts = node[len(WORKSPACE_READ) :]
            if parts:
                found.add(self.agents / parts[0])
                found.add(self.agents.joinpath(parts[0], WORKSPACE, *parts[1:]))
        return found

    def sandbox(self, permissions: Permissions | None) -> Sandbox:
        root = Path(self.library.anchor)
        root_access = self.access(permissions, root)
        states: dict[Path, Access] = {root: root_access}
        mounts: list[Mount] = []
        for path in sorted(
            self._candidates(permissions) - {root},
            key=lambda item: (len(item.parts), str(item)),
        ):
            state = self.access(permissions, path)
            inherited = next(
                (states[parent] for parent in path.parents if parent in states),
                root_access,
            )
            states[path] = state
            if state != inherited:
                mounts.append(Mount(path, state))
        return Sandbox(root_access, tuple(mounts), self.links)


def require_protected(sandbox: Sandbox) -> None:
    # 受保护的路径要先存在才能只读挂载；Fora 不知道它该是文件还是目录，所以不替成员创建
    missing = [str(path) for path in sandbox.protected() if not path.exists()]
    if missing:
        raise DomainError(
            ErrorCode.SANDBOX_UNAVAILABLE,
            "Commands cannot run until these paths you may not change exist: "
            f"{', '.join(missing)}. Ask a Member who may write there to create them.",
        )
