from __future__ import annotations

import os
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import fora
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError


@dataclass(frozen=True)
class NormalizedDirectories:
    accepted: tuple[Path, ...]
    skipped: tuple[tuple[str, str], ...]


def _normalize_one(value: object, *, require_existing: bool, kind: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise DomainError(
            ErrorCode.INVALID_DIRECTORY,
            f"{kind} directories must be non-empty strings",
        )
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        if PurePosixPath(value).is_absolute():
            raise DomainError(
                ErrorCode.FOREIGN_DIRECTORY,
                f"{value} is a POSIX path and cannot be used on this platform",
            )
        raise DomainError(
            ErrorCode.INVALID_DIRECTORY, f"{kind} directories must be absolute paths"
        )
    try:
        resolved = candidate.resolve(strict=require_existing)
    except (OSError, RuntimeError, ValueError) as error:
        raise DomainError(
            ErrorCode.INVALID_DIRECTORY,
            f"Cannot resolve {kind.lower()} directory: {error}",
        ) from error
    if require_existing and not resolved.is_dir():
        raise DomainError(
            ErrorCode.INVALID_DIRECTORY,
            f"{kind} directories must be existing directories",
        )
    return resolved


def normalize_directories(
    values: Sequence[str],
    *,
    require_existing: bool = False,
    kind: str = "Writable",
) -> tuple[Path, ...]:
    normalized: list[Path] = []
    seen: set[str] = set()
    for value in values:
        resolved = _normalize_one(value, require_existing=require_existing, kind=kind)
        identity = os.path.normcase(str(resolved))
        if identity in seen:
            continue
        seen.add(identity)
        normalized.append(resolved)
    return tuple(normalized)


def normalize_tolerantly(
    values: Sequence[str], *, kind: str = "Writable"
) -> NormalizedDirectories:
    accepted: list[Path] = []
    skipped: list[tuple[str, str]] = []
    seen: set[str] = set()
    for value in values:
        try:
            resolved = _normalize_one(value, require_existing=False, kind=kind)
        except DomainError as error:
            skipped.append((str(value), error.code))
            continue
        identity = os.path.normcase(str(resolved))
        if identity in seen:
            continue
        seen.add(identity)
        accepted.append(resolved)
    return NormalizedDirectories(tuple(accepted), tuple(skipped))


LINUX_READS = (
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib32",
    "/lib64",
    "/etc",
    "/opt",
    "/tmp",
    "/var/tmp",
    "/run",
)
MACOS_READS = (
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/Applications",
    "/opt",
    "/private",
    "/etc",
    "/tmp",
    "/var",
    "/dev",
)


def default_read_directories() -> tuple[str, ...]:
    if sys.platform == "darwin":
        return MACOS_READS
    if sys.platform.startswith("linux"):
        return LINUX_READS
    return ()


def symlinks_on(path: Path) -> tuple[tuple[Path, str], ...]:
    # 解析路径时经过的每个符号链接；沙箱里要重建它们，否则路径走到一半就断了
    found: list[tuple[Path, str]] = []
    current = Path(path.anchor)
    pending = list(path.parts[1:])
    while pending:
        candidate = current / pending.pop(0)
        if not candidate.is_symlink():
            current = candidate
            continue
        if len(found) > 40:
            raise OSError(f"Too many symbolic links resolving {path}")
        target = os.readlink(candidate)
        found.append((candidate, target))
        resolved = candidate.parent / target
        current = Path(resolved.anchor)
        pending = list(resolved.parts[1:]) + pending
    return tuple(found)


def interpreter_links() -> tuple[tuple[Path, str], ...]:
    return symlinks_on(Path(sys.executable).absolute())


def interpreter_directories() -> tuple[str, ...]:
    # 沙箱里的辅助进程运行 `python -m fora`，开发安装时 fora 的源码不在解释器目录里
    return tuple(
        dict.fromkeys(
            (
                sys.prefix,
                sys.base_prefix,
                str(Path(sys.executable).resolve().parent.parent),
                str(Path(fora.__file__).resolve().parent.parent),
            )
        )
    )


def is_within(path: Path, roots: Sequence[Path]) -> bool:
    return any(path == root or path.is_relative_to(root) for root in roots)
