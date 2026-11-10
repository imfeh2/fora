from __future__ import annotations

import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

from fora.adapters.execution.local import LocalExecution
from fora.adapters.execution.manager import ExecutionManager
from fora.adapters.files.tree import DirectoryTree
from fora.adapters.files.uploads import decode_image
from fora.adapters.sandbox.commands import linux_command
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.permissions import SqlitePermissionStore
from fora.adapters.sqlite.store import SqliteStore
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.tools import AgentTools, Dependencies
from fora.tools.authorize import Actor, Authorizer

OWNER = 1
LEAD = 2
REVIEWER = 3


@dataclass
class World:
    root: Path
    project: Path
    deps: Dependencies
    authorizer: Authorizer
    permissions: SqlitePermissionStore

    def tools(self, member_id: int) -> AgentTools:
        return AgentTools(
            self.deps,
            Actor(member_id, member_id != OWNER),
            self.authorizer,
        )


@pytest.fixture
def world(tmp_path: Path) -> Iterator[World]:
    store = SqliteStore(tmp_path / "fora.sqlite3")
    agent_store = SqliteAgentStore(store._db)
    store.create_member("human", "You")
    store.create_member("agent", "Lead")
    store.create_member("agent", "Reviewer")
    permissions = SqlitePermissionStore(store._db)
    permissions.set_owner(OWNER)
    project = tmp_path / "project"
    (project / "fora" / "core").mkdir(parents=True)
    (tmp_path / "library" / "specs").mkdir(parents=True)
    (tmp_path / "library" / "rules").mkdir(parents=True)

    def agent_directory_for(member_id: int) -> Path:
        path = tmp_path / "agents" / str(member_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    execution = ExecutionManager(
        settings={"write_directories": [str(project)]}, enforce=False
    )
    deps = Dependencies(
        store=store,
        history=agent_store,
        settings=agent_store,
        execution=execution,
        agent_directory_for=agent_directory_for,
        decode_image=decode_image,
        library_tree=DirectoryTree(tmp_path / "library"),
        workspace_tree_for=lambda member_id: DirectoryTree(
            agent_directory_for(member_id) / "workspace"
        ),
    )
    try:
        yield World(tmp_path, project, deps, Authorizer(permissions), permissions)
    finally:
        execution.close()
        store.close()


def lead_holds_everything_except_specs(world: World) -> None:
    world.tools(OWNER).grant_permissions(
        LEAD,
        [
            {"sign": "+", "node": [], "delegable": True},
            {"sign": "-", "node": ["library", "write", "specs"]},
        ],
    )


def denied(action) -> DomainError:
    with pytest.raises(DomainError) as error:
        action()
    assert error.value.code == ErrorCode.NOT_PERMITTED
    return error.value


def test_a_new_agent_can_read_and_keep_notes_but_change_nothing_shared(
    world: World,
) -> None:
    lead = world.tools(LEAD)
    (world.root / "library" / "rules" / "flow.md").write_text("Flow.\n")

    assert lead.read_library("rules/flow.md")["content"] == "Flow.\n"
    lead.edit(
        "workspace/notes.md",
        [{"old_text": "", "new_text": "Mine.\n"}],
        create=True,
    )
    denied(lambda: lead.write_library("rules/flow.md", "Changed.\n"))
    denied(lambda: lead.create_discussion("Topic", [OWNER]))
    denied(lambda: lead.run(["true"]))


def test_the_owner_needs_no_grant(world: World) -> None:
    owner = world.tools(OWNER)

    owner.write_library("specs/context.md", "Context.\n")
    assert owner.list_permissions()["owner"] is True


def test_an_excluded_branch_stays_closed_through_every_write_path(
    world: World,
) -> None:
    lead_holds_everything_except_specs(world)
    lead = world.tools(LEAD)

    lead.write_library("rules/flow.md", "Flow.\n")
    lead.create_discussion("Topic", [OWNER])
    denied(lambda: lead.write_library("specs/context.md", "Mine.\n"))
    denied(lambda: lead.mkdir_library("specs/drafts"))
    denied(lambda: lead.move_library("rules/flow.md", "specs/flow.md"))
    denied(
        lambda: lead.edit(
            str(world.root / "library" / "specs" / "context.md"),
            [{"old_text": "", "new_text": "Mine.\n"}],
            create=True,
        )
    )
    assert not (world.root / "library" / "specs" / "context.md").exists()
    assert lead.list_permissions()["grants"][0]["lines"] == [
        "+ * (delegable)",
        "- library:write:specs",
    ]


def test_a_grant_passes_on_only_what_the_granter_may_delegate(world: World) -> None:
    lead_holds_everything_except_specs(world)
    lead = world.tools(LEAD)

    denied(
        lambda: lead.grant_permissions(
            REVIEWER, [{"sign": "+", "node": ["library", "write", "specs"]}]
        )
    )
    granted = lead.grant_permissions(
        REVIEWER, [{"sign": "+", "node": ["library", "write"]}]
    )
    reviewer = world.tools(REVIEWER)

    reviewer.write_library("rules/review.md", "Review.\n")
    denied(lambda: reviewer.write_library("specs/context.md", "Mine.\n"))
    denied(
        lambda: reviewer.grant_permissions(
            LEAD, [{"sign": "+", "node": ["library", "write", "rules"]}]
        )
    )
    assert granted["parent_id"] == 1


def test_revoking_upstream_ends_the_grants_made_from_it(world: World) -> None:
    lead_holds_everything_except_specs(world)
    world.tools(LEAD).grant_permissions(
        REVIEWER, [{"sign": "+", "node": ["library", "write"]}]
    )
    reviewer = world.tools(REVIEWER)
    denied(lambda: reviewer.revoke_permissions(1))

    world.tools(OWNER).revoke_permissions(1)

    denied(lambda: reviewer.write_library("rules/review.md", "Review.\n"))
    assert reviewer.list_permissions()["grants"] == []


def test_deleting_an_agent_ends_what_it_handed_out(world: World) -> None:
    lead_holds_everything_except_specs(world)
    world.tools(LEAD).grant_permissions(
        REVIEWER, [{"sign": "+", "node": ["library", "write"]}]
    )

    world.tools(OWNER).delete_agent(LEAD)

    denied(lambda: world.tools(REVIEWER).write_library("rules/review.md", "Review.\n"))


def test_commands_write_only_where_the_grants_allow(world: World) -> None:
    core = world.project / "fora" / "core"
    world.tools(OWNER).grant_permissions(
        LEAD,
        [
            {"sign": "+", "node": ["tools", "run"]},
            {
                "sign": "+",
                "node": ["files", "write", *world.project.resolve().parts[1:]],
            },
            {
                "sign": "-",
                "node": ["files", "write", *core.resolve().parts[1:]],
            },
            {"sign": "+", "node": ["library", "write", "rules"]},
        ],
    )
    lead = world.tools(LEAD)
    execution = world.deps.execution.snapshot()

    plan = lead.write_plan(execution)

    library = (world.root / "library").resolve()
    workspace = (world.root / "agents" / str(LEAD) / "workspace").resolve()
    assert set(plan.writable) == {
        world.project.resolve(),
        library / "rules",
        workspace,
    }
    assert plan.protected == (core.resolve(),)
    command = linux_command(
        ["true"], workspace, plan.writable, plan.protected, bwrap="bwrap", root=False
    )
    project_bind = command.index(str(world.project.resolve()))
    core_bind = command.index(str(core.resolve()))
    assert command[project_bind - 1] == "--bind"
    assert command[core_bind - 1] == "--ro-bind"
    assert project_bind < core_bind
    assert lead.run(["true"])["exit_code"] == 0


@pytest.mark.skipif(
    sys.platform != "linux", reason="protected paths are enforced on Linux"
)
def test_the_sandbox_keeps_a_protected_path_read_only(tmp_path: Path) -> None:
    writable = tmp_path / "project"
    protected = writable / "core"
    protected.mkdir(parents=True)
    execution = LocalExecution([str(writable)])
    try:
        result = execution.run(
            [
                "sh",
                "-c",
                "touch open.txt && echo ok && touch core/closed.txt",
            ],
            cwd=str(writable),
            write_directories=[str(writable)],
            protected_directories=[str(protected)],
        )
    finally:
        execution.close()

    assert result.stdout.strip() == "ok"
    assert result.exit_code != 0
    assert (writable / "open.txt").exists()
    assert not (protected / "closed.txt").exists()


def test_commands_refuse_to_run_while_a_protected_path_is_missing(
    world: World,
) -> None:
    world.tools(OWNER).grant_permissions(
        LEAD,
        [
            {"sign": "+", "node": ["tools", "run"]},
            {"sign": "+", "node": ["library", "write"]},
            {"sign": "-", "node": ["library", "write", "decisions"]},
        ],
    )

    with pytest.raises(DomainError) as error:
        world.tools(LEAD).run(["true"])

    assert error.value.code == ErrorCode.SANDBOX_UNAVAILABLE
    assert "decisions" in str(error.value)


def test_the_environment_lists_what_this_member_can_write(world: World) -> None:
    lead_holds_everything_except_specs(world)
    execution = world.deps.execution.snapshot()
    plan = world.tools(LEAD).write_plan(execution)

    text = execution.describe_environment(
        (),
        [str(path) for path in plan.writable],
        [str(path) for path in plan.protected],
    )

    assert str((world.root / "library" / "specs").resolve()) in text
    assert "Read-only inside them:" in text
