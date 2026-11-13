from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from markdown_it import MarkdownIt

from fora.core.errors import DomainError
from fora.ports.files import FileTree
from fora.tools import AgentTools

FILES = (
    ("library", "The organization's AGENTS.md from the Library"),
    ("workspace", "Your workspace AGENTS.md"),
)
SKILLS_HEADER = (
    "Skills you can read with the skills tool. Read a skill before starting"
    " the kind of work it covers:"
)
CHANGES_HEADER = (
    "Your instructions changed. Each section and skill below replaces the earlier"
    " text with the same name in this context window; everything not listed stays"
    " as it was."
)


@dataclass(frozen=True)
class Skill:
    name: str
    source: str
    description: str

    def line(self) -> str:
        return f"- {self.name} ({self.source}): {self.description}"


@dataclass(frozen=True)
class Instructions:
    files: tuple[tuple[str, str], ...]
    skills: tuple[Skill, ...]


def _read(tree: FileTree) -> str:
    try:
        content, _ = tree.read("AGENTS.md")
    except DomainError as error:
        if error.code == "not_found":
            return ""
        raise DomainError(error.code, f"{tree.root / 'AGENTS.md'}: {error}") from error
    return content if content.strip() else ""


def read_instructions(
    tools: AgentTools, library: FileTree, workspace: FileTree
) -> Instructions:
    return Instructions(
        files=(("library", _read(library)), ("workspace", _read(workspace))),
        skills=tuple(
            Skill(
                skill["name"], skill["source"], " ".join(skill["description"].split())
            )
            for skill in tools.list_skills()
        ),
    )


def _digest(text: str) -> str:
    return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()[:16]


def sections(text: str) -> list[tuple[str, str]]:
    lines = text.splitlines()
    tokens = MarkdownIt("commonmark").parse(text)
    starts: list[tuple[int, int, str]] = []
    for index, token in enumerate(tokens):
        if token.type == "heading_open" and token.map is not None:
            starts.append((token.map[0], int(token.tag[1:]), tokens[index + 1].content))
    result: list[tuple[str, str]] = []
    first = starts[0][0] if starts else len(lines)
    if "\n".join(lines[:first]).strip():
        result.append(("", "\n".join(lines[:first]).strip()))
    path: list[tuple[int, str]] = []
    seen: dict[str, int] = {}
    for number, (start, level, title) in enumerate(starts):
        end = starts[number + 1][0] if number + 1 < len(starts) else len(lines)
        path = [*(item for item in path if item[0] < level), (level, title)]
        key = " > ".join(item[1] for item in path)
        seen[key] = seen.get(key, 0) + 1
        if seen[key] > 1:
            key = f"{key} ({seen[key]})"
        result.append((key, "\n".join(lines[start:end]).strip()))
    return result


def render(instructions: Instructions) -> str:
    parts = [
        f"{label}:\n{text}"
        for (name, label) in FILES
        for (source, text) in instructions.files
        if source == name and text
    ]
    if instructions.skills:
        parts.append(
            SKILLS_HEADER
            + "\n"
            + "\n".join(skill.line() for skill in instructions.skills)
        )
    return "\n\n".join(parts)


def state(instructions: Instructions) -> dict[str, Any]:
    return {
        "files": {
            source: [[key, _digest(text)] for key, text in sections(content)]
            for source, content in instructions.files
        },
        "skills": [
            [skill.source, skill.name, _digest(skill.description)]
            for skill in instructions.skills
        ],
    }


def changes(previous: dict[str, Any] | None, current: Instructions) -> str | None:
    before = previous or {"files": {}, "skills": []}
    parts = []
    for name, label in FILES:
        content = dict(current.files).get(name, "")
        old = {key: value for key, value in before["files"].get(name, [])}
        now = sections(content)
        changed = [
            f"Section {key or '(before the first heading)'}:\n{text}"
            for key, text in now
            if old.get(key) != _digest(text)
        ]
        removed = [
            key or "(before the first heading)" for key in old if key not in dict(now)
        ]
        if changed:
            parts.append(f"{label}, changed sections:\n\n" + "\n\n".join(changed))
        if removed:
            parts.append(f"{label}, removed sections: " + "; ".join(removed))
    old_skills = {(source, name): value for source, name, value in before["skills"]}
    current_keys = {(skill.source, skill.name) for skill in current.skills}
    changed_skills = [
        skill.line()
        for skill in current.skills
        if old_skills.get((skill.source, skill.name)) != _digest(skill.description)
    ]
    removed_skills = [
        f"- {name} ({source})"
        for (source, name) in old_skills
        if (source, name) not in current_keys
    ]
    if changed_skills:
        parts.append("Skills added or changed:\n" + "\n".join(changed_skills))
    if removed_skills:
        parts.append("Skills removed:\n" + "\n".join(removed_skills))
    if not parts:
        return None
    return CHANGES_HEADER + "\n\n" + "\n\n".join(parts)
