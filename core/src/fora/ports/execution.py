from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path
from typing import Any, Protocol


@dataclass(frozen=True)
class RunResult:
    exit_code: int
    stdout: str
    stderr: str
    truncated: bool


@dataclass(frozen=True)
class EditResult:
    path: str
    diff: str
    replacements: int


class Access(IntEnum):
    HIDDEN = 0
    READ = 1
    WRITE = 2


@dataclass(frozen=True)
class Mount:
    path: Path
    access: Access


@dataclass(frozen=True)
class Sandbox:
    root: Access
    mounts: tuple[Mount, ...] = ()
    links: tuple[tuple[Path, str], ...] = ()
    anchor: Path = Path("/")

    def writable(self) -> tuple[Path, ...]:
        # 根目录可写时，它本身也是一个可写目录
        rooted = (self.anchor,) if self.root is Access.WRITE else ()
        return (*rooted, *self.paths(Access.WRITE))

    def ordered(self) -> tuple[Mount, ...]:
        return tuple(
            sorted(
                self.mounts, key=lambda mount: (len(mount.path.parts), str(mount.path))
            )
        )

    def inherited(self, path: Path) -> Access:
        enclosing = [
            mount
            for mount in self.mounts
            if mount.path != path and path.is_relative_to(mount.path)
        ]
        if not enclosing:
            return self.root
        return max(enclosing, key=lambda mount: len(mount.path.parts)).access

    def access(self, path: Path) -> Access:
        for mount in self.mounts:
            if mount.path == path:
                return mount.access
        return self.inherited(path)

    def paths(self, access: Access) -> tuple[Path, ...]:
        return tuple(mount.path for mount in self.ordered() if mount.access is access)

    def protected(self) -> tuple[Path, ...]:
        return tuple(
            mount.path
            for mount in self.ordered()
            if mount.access is not Access.WRITE
            and self.inherited(mount.path) is Access.WRITE
        )


class ExecutionEnvironment(Protocol):
    @property
    def skipped(self) -> tuple[tuple[str, str], ...]: ...

    @property
    def write_directories(self) -> tuple[str, ...]: ...

    @property
    def read_directories(self) -> tuple[str, ...]: ...

    @property
    def read_links(self) -> tuple[tuple[Path, str], ...]: ...

    def describe_environment(
        self,
        labeled: Sequence[tuple[str, str]] = (),
        sandbox: Sandbox | None = None,
    ) -> str: ...

    def resolve_path(self, value: str, *, base: str) -> str: ...

    def read_file(
        self,
        path: str,
        max_bytes: int,
        *,
        timeout: int | None = None,
        sandbox: Sandbox | None = None,
    ) -> bytes: ...

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: str,
        timeout: int | None = None,
        sandbox: Sandbox | None = None,
    ) -> RunResult: ...

    def edit(
        self,
        path: str,
        edits: Sequence[Mapping[str, object]],
        *,
        write_directories: Sequence[str] | None = None,
        create: bool = False,
    ) -> EditResult: ...


class ExecutionControl(Protocol):
    def snapshot(self) -> ExecutionEnvironment: ...

    def status(self) -> dict[str, Any]: ...

    def configure(
        self, values: dict[str, Any], persist: Callable[[dict[str, object]], None]
    ) -> dict[str, Any]: ...

    def close(self) -> None: ...
