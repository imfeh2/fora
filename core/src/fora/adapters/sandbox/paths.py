from __future__ import annotations

import os
import sys
from collections.abc import Sequence
from pathlib import Path

import fora


def symlinks_on(path: Path) -> tuple[tuple[Path, str], ...]:
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


def sandbox_links() -> tuple[tuple[Path, str], ...]:
    anchor = Path(Path(sys.executable).anchor)
    rooted = (
        (entry, os.readlink(entry))
        for entry in sorted(anchor.iterdir())
        if entry.is_symlink()
    )
    return tuple(
        dict.fromkeys((*rooted, *symlinks_on(Path(sys.executable).absolute())))
    )


SYSTEM_LIBRARIES: dict[str, tuple[str, ...]] = {
    "linux": ("/usr",),
    "darwin": ("/usr", "/System", "/Library"),
}


def helper_directories() -> tuple[Path, ...]:
    system: tuple[str, ...] = next(
        (
            dirs
            for name, dirs in SYSTEM_LIBRARIES.items()
            if sys.platform.startswith(name)
        ),
        (),
    )
    return tuple(
        dict.fromkeys(
            Path(item).resolve()
            for item in (
                *system,
                sys.prefix,
                sys.base_prefix,
                str(Path(sys.executable).resolve().parent.parent),
                str(Path(fora.__file__).resolve().parent.parent),
            )
        )
    )


def is_within(path: Path, roots: Sequence[Path]) -> bool:
    return any(path == root or path.is_relative_to(root) for root in roots)
