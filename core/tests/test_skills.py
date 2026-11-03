from __future__ import annotations

from pathlib import Path

import pytest

from fora.adapters.execution.manager import ExecutionManager
from fora.adapters.files.tree import DirectoryTree
from fora.adapters.files.uploads import decode_image
from fora.adapters.model.prompt import SYSTEM_PROMPT
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.tools import AgentTools, Dependencies
from fora.tools.authorize import Actor

MAIN = 2


def write_skill(root: Path, name: str, description: str, body: str) -> Path:
    directory = root / "skills" / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n",
        encoding="utf-8",
    )
    return directory


@pytest.fixture
def world(tmp_path: Path):
    store = SqliteStore(tmp_path / "fora.sqlite3")
    agent_store = SqliteAgentStore(store._db)
    store.create_member("human", "You")
    store.create_member("agent", "Main")

    def agent_directory_for(member_id: int) -> Path:
        path = tmp_path / "agents" / str(member_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    library = tmp_path / "library"
    workspace = tmp_path / "agents" / str(MAIN) / "workspace"
    library.mkdir(parents=True)
    workspace.mkdir(parents=True)
    deps = Dependencies(
        store=store,
        history=agent_store,
        settings=agent_store,
        execution=ExecutionManager(enforce=False),
        agent_directory_for=agent_directory_for,
        decode_image=decode_image,
        library_tree=DirectoryTree(library),
        workspace_tree_for=lambda member_id: DirectoryTree(workspace),
    )
    tools = AgentTools(deps=deps, actor=Actor(member_id=MAIN, is_agent=True))
    yield tools, library, workspace
    deps.execution.close()
    store.close()


def test_the_list_names_every_skill_and_its_source(world) -> None:
    tools, library, workspace = world
    write_skill(library, "shared-one", "Shared skill one.", "Shared body one.")
    write_skill(library, "shared-two", "Shared skill two.", "Shared body two.")
    write_skill(workspace, "private-one", "Private skill one.", "Private body.")

    assert tools.list_skills()["skills"] == [
        {
            "name": "private-one",
            "description": "Private skill one.",
            "source": "workspace",
        },
        {
            "name": "shared-one",
            "description": "Shared skill one.",
            "source": "library",
        },
        {
            "name": "shared-two",
            "description": "Shared skill two.",
            "source": "library",
        },
    ]


def test_a_shared_name_is_read_from_the_workspace(world) -> None:
    tools, library, workspace = world
    write_skill(library, "task-flow", "Shared copy.", "Shared body.")
    write_skill(workspace, "task-flow", "Private copy.", "Private body.")

    assert tools.list_skills()["skills"] == [
        {
            "name": "task-flow",
            "description": "Private copy.",
            "source": "workspace",
        }
    ]
    assert "Private body." in tools.read_skill("task-flow")["content"]
    assert "Shared body." not in tools.read_skill("task-flow")["content"]


def test_reading_a_skill_returns_its_text_and_where_it_lives(world) -> None:
    tools, library, _ = world
    directory = write_skill(library, "task-flow", "Shared copy.", "Full body.")
    (directory / "notes.md").write_text("Extra notes.\n", encoding="utf-8")

    payload = tools.read_skill("task-flow")
    assert payload["name"] == "task-flow"
    assert payload["description"] == "Shared copy."
    assert payload["path"] == "skills/task-flow"
    assert "Full body." in payload["content"]
    notes, _ = DirectoryTree(library).read(f"{payload['path']}/notes.md")
    assert notes == "Extra notes.\n"


def test_editing_a_skill_shows_up_on_the_next_read(world) -> None:
    tools, library, _ = world
    write_skill(library, "task-flow", "First description.", "First body.")
    assert "First body." in tools.read_skill("task-flow")["content"]

    write_skill(library, "task-flow", "Second description.", "Second body.")

    payload = tools.read_skill("task-flow")
    assert "Second body." in payload["content"]
    assert "First body." not in payload["content"]
    assert payload["description"] == "Second description."
    assert [item["description"] for item in tools.list_skills()["skills"]] == [
        "Second description."
    ]


def test_broken_skills_do_not_break_the_list(world) -> None:
    tools, _, workspace = world
    skills = workspace / "skills"
    (skills / "broken").mkdir(parents=True)
    (skills / "broken" / "SKILL.md").write_text(
        "---\nname: broken\ndescription: [unclosed\n---\n\nBody.\n",
        encoding="utf-8",
    )
    (skills / "undescribed").mkdir(parents=True)
    (skills / "undescribed" / "SKILL.md").write_text(
        "---\nname: undescribed\n---\n\nNo description.\n", encoding="utf-8"
    )
    (skills / "undecodable").mkdir(parents=True)
    (skills / "undecodable" / "SKILL.md").write_bytes(
        b"\xff\xfe---\nname: undecodable\n"
    )
    (skills / "empty").mkdir(parents=True)
    (skills / "empty" / "notes.txt").write_text("not a skill\n", encoding="utf-8")

    assert tools.list_skills()["skills"] == [
        {"name": "broken", "description": "broken", "source": "workspace"},
        {
            "name": "undecodable",
            "description": "undecodable",
            "source": "workspace",
        },
        {
            "name": "undescribed",
            "description": "undescribed",
            "source": "workspace",
        },
    ]
    with pytest.raises(DomainError) as error:
        tools.read_skill("undecodable")
    assert error.value.code == ErrorCode.NOT_READABLE
    assert "cannot be read" in str(error.value)


def test_an_empty_source_says_so(world) -> None:
    tools, _, _ = world
    assert tools.list_skills() == {
        "skills": [],
        "note": "No skills are available.",
    }


def test_an_unknown_name_points_back_to_the_list(world) -> None:
    tools, _, _ = world
    with pytest.raises(DomainError) as error:
        tools.read_skill("no-such-skill")
    assert error.value.code == ErrorCode.NOT_FOUND
    assert 'No skill named "no-such-skill"' in str(error.value)
    assert "action=list" in str(error.value)


def test_the_resident_prompt_only_points_at_the_tool() -> None:
    mentions = [line for line in SYSTEM_PROMPT.splitlines() if "skill" in line.lower()]
    assert mentions == ["Skills are loaded on demand with the skills tool."]
    for name in ("task-flow", "privacy-guard"):
        assert name not in SYSTEM_PROMPT
