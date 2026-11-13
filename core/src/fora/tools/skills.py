from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import yaml

from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.ports.files import FileTree

SKILLS = "skills"
DOCUMENT = "SKILL.md"
FENCE = "---"
LIBRARY = "library"
WORKSPACE = "workspace"


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    source: str

    def payload(self) -> dict[str, str]:
        return {
            "name": self.name,
            "description": self.description,
            "source": self.source,
        }


def frontmatter(text: str) -> dict[str, Any]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != FENCE:
        return {}
    for index in range(1, len(lines)):
        if lines[index].strip() == FENCE:
            break
    else:
        return {}
    try:
        loaded = yaml.safe_load("\n".join(lines[1:index]))
    except yaml.YAMLError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def describe(text: str, name: str) -> str:
    value = frontmatter(text).get("description")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return name


def _directories(tree: FileTree) -> tuple[str, ...]:
    return tuple(
        entry.path
        for entry in tree.list(SKILLS)
        if entry.kind == "directory" and entry.path.count("/") == 1
    )


def _named(tree: FileTree, source: str) -> dict[str, Skill]:
    found = {}
    for path in _directories(tree):
        name = path.rsplit("/", 1)[-1]
        try:
            text, _ = tree.read(f"{path}/{DOCUMENT}")
        except DomainError as error:
            if error.code == ErrorCode.NOT_FOUND:
                continue
            found[name] = Skill(name, name, source)
            continue
        found[name] = Skill(name, describe(text, name), source)
    return found


def discover(library: FileTree, workspace: FileTree) -> list[Skill]:
    found = _named(library, LIBRARY)
    found.update(_named(workspace, WORKSPACE))
    return [found[name] for name in sorted(found)]


def load(tree: FileTree, source: str, name: str) -> dict[str, str]:
    if not name or name in (".", "..") or "/" in name:
        raise _missing(name)
    path = f"{SKILLS}/{name}/{DOCUMENT}"
    try:
        text, _ = tree.read(path)
    except DomainError as error:
        if error.code != ErrorCode.NOT_FOUND:
            raise
        raise _missing(name) from None
    return {
        "name": name,
        "description": describe(text, name),
        "source": source,
        "path": f"{SKILLS}/{name}",
        "content": text,
    }


def _missing(name: str) -> DomainError:
    return DomainError(
        ErrorCode.NOT_FOUND,
        f'No skill named "{name}". Your context lists the skills you can read.',
    )
