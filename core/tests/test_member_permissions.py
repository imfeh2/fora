from __future__ import annotations

import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

import fora
from fora.adapters.execution.local import LocalExecution
from fora.adapters.execution.manager import ExecutionManager
from fora.adapters.files.tree import DirectoryTree
from fora.adapters.files.uploads import decode_image
from fora.adapters.sandbox.commands import linux_command, macos_profile
from fora.adapters.sandbox.paths import interpreter_directories
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.permissions import SqlitePermissionStore
from fora.adapters.sqlite.store import SqliteStore
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.ports.execution import Access, Mount, Sandbox
from fora.tools import AgentTools, Dependencies
from fora.tools.authorize import Actor, Authorizer

OWNER = 1
LEAD = 2
REVIEWER = 3
SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]
linux = pytest.mark.skipif(
    sys.platform != "linux", reason="the bubblewrap sandbox runs on Linux"
)


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

    def workspace(self, member_id: int) -> Path:
        return self.root / "agents" / str(member_id) / "workspace"


def build(tmp_path: Path, *, enforce: bool) -> Iterator[World]:
    data = tmp_path / "data"
    data.mkdir()
    store = SqliteStore(data / "fora.sqlite3")
    agent_store = SqliteAgentStore(store._db)
    store.create_member("human", "You")
    store.create_member("agent", "Lead")
    store.create_member("agent", "Reviewer")
    permissions = SqlitePermissionStore(store._db)
    permissions.set_owner(OWNER)
    project = tmp_path / "project"
    (project / "fora" / "core").mkdir(parents=True)
    (data / "library" / "specs").mkdir(parents=True)
    (data / "library" / "rules").mkdir(parents=True)

    def agent_directory_for(member_id: int) -> Path:
        path = data / "agents" / str(member_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    for member_id in (LEAD, REVIEWER):
        (agent_directory_for(member_id) / "workspace").mkdir(exist_ok=True)
    execution = ExecutionManager(
        settings={"write_directories": [str(project)], "read_directories": SYSTEM},
        enforce=enforce,
    )
    deps = Dependencies(
        store=store,
        history=agent_store,
        settings=agent_store,
        execution=execution,
        agent_directory_for=agent_directory_for,
        decode_image=decode_image,
        data_directory=data,
        library_tree=DirectoryTree(data / "library"),
        workspace_tree_for=lambda member_id: DirectoryTree(
            agent_directory_for(member_id) / "workspace"
        ),
    )
    try:
        yield World(data, project, deps, Authorizer(permissions), permissions)
    finally:
        execution.close()
        store.close()


@pytest.fixture
def world(tmp_path: Path) -> Iterator[World]:
    yield from build(tmp_path, enforce=False)


@pytest.fixture
def sandboxed(tmp_path: Path) -> Iterator[World]:
    yield from build(tmp_path, enforce=True)


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


def path_entry(sign: str, action: str, path: Path) -> dict[str, object]:
    return {"sign": sign, "node": ["files", action, *path.resolve().parts[1:]]}


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


def test_the_sandbox_follows_the_grants(world: World) -> None:
    core = (world.project / "fora" / "core").resolve()
    world.tools(OWNER).grant_permissions(
        LEAD,
        [
            {"sign": "+", "node": ["tools", "run"]},
            path_entry("+", "write", world.project),
            path_entry("-", "write", core),
            {"sign": "+", "node": ["library", "write", "rules"]},
        ],
    )

    sandbox = world.tools(LEAD).sandbox(world.deps.execution.snapshot())

    library = (world.root / "library").resolve()
    workspace = world.workspace(LEAD).resolve()
    assert sandbox.root is Access.HIDDEN
    assert set(sandbox.paths(Access.WRITE)) == {
        world.project.resolve(),
        library / "rules",
        workspace,
    }
    assert sandbox.protected() == (core,)
    assert sandbox.access(library) is Access.READ
    assert sandbox.access(world.workspace(REVIEWER).resolve()) is Access.HIDDEN
    assert sandbox.access((world.root / "fora.sqlite3").resolve()) is Access.HIDDEN
    assert sandbox.access(Path("/usr")) is Access.READ
    assert sandbox.access(Path("/home")) is Access.HIDDEN


def test_a_broad_grant_sees_the_whole_machine_but_not_fora_data(world: World) -> None:
    lead_holds_everything_except_specs(world)

    sandbox = world.tools(LEAD).sandbox(world.deps.execution.snapshot())

    data = world.root.resolve()
    assert sandbox.root is Access.READ
    assert sandbox.access(data / "fora.sqlite3") is Access.HIDDEN
    assert sandbox.access(data / "library" / "rules") is Access.WRITE
    assert sandbox.access(data / "library" / "specs") is Access.READ
    assert sandbox.access(world.workspace(REVIEWER).resolve()) is Access.READ
    assert sandbox.access(data / "uploads") is Access.READ


def test_bubblewrap_mounts_shallow_paths_first(tmp_path: Path) -> None:
    project = tmp_path / "project"
    core = project / "core"
    secret = project / "secret"
    for directory in (core, secret):
        directory.mkdir(parents=True)
    sandbox = Sandbox(
        Access.HIDDEN,
        (
            Mount(core, Access.READ),
            Mount(project, Access.WRITE),
            Mount(secret, Access.HIDDEN),
            Mount(Path("/usr"), Access.READ),
        ),
    )

    command = linux_command(["true"], project, sandbox, bwrap="bwrap", root=False)

    assert "/" not in command[: command.index("--dev")]
    assert command.index(str(project)) < command.index(str(core))
    assert command[command.index(str(core)) - 1] == "--ro-bind"
    assert command[command.index(str(secret)) - 1] == "--tmpfs"


def test_the_macos_profile_denies_what_the_plan_closes(tmp_path: Path) -> None:
    project = tmp_path / "project"
    sandbox = Sandbox(
        Access.HIDDEN,
        (
            Mount(Path("/usr"), Access.READ),
            Mount(project, Access.WRITE),
            Mount(project / "core", Access.READ),
            Mount(project / "secret", Access.HIDDEN),
        ),
    )

    profile, parameters = macos_profile(sandbox)

    assert profile.count("(deny file-write*") == 3
    assert profile.count("(deny file-read-data") == 2
    assert f"-DPATH_1={project.as_posix()}" in parameters
    assert '(require-not (subpath "/dev"))' in profile


macos = pytest.mark.skipif(
    sys.platform != "darwin", reason="the macOS sandbox runs on macOS"
)


@macos
def test_the_macos_sandbox_follows_the_plan(tmp_path: Path) -> None:
    project = tmp_path / "project"
    core = project / "core"
    secret = project / "secret"
    for directory in (core, secret):
        directory.mkdir(parents=True)
    (secret / "key.txt").write_text("hidden\n")
    execution = LocalExecution([str(project)])
    try:
        result = execution.run(
            [
                "sh",
                "-c",
                (
                    "touch open.txt && echo wrote; "
                    "touch core/closed.txt || echo blocked; "
                    "cat secret/key.txt || echo hidden"
                ),
            ],
            cwd=str(project),
            sandbox=Sandbox(
                Access.READ,
                (
                    Mount(project.resolve(), Access.WRITE),
                    Mount(core.resolve(), Access.READ),
                    Mount(secret.resolve(), Access.HIDDEN),
                ),
            ),
        )
    finally:
        execution.close()

    assert result.stdout.split() == ["wrote", "blocked", "hidden"]
    assert not (core / "closed.txt").exists()


@linux
def test_commands_cannot_write_into_a_protected_path(sandboxed: World) -> None:
    core = sandboxed.project / "fora" / "core"
    sandboxed.tools(OWNER).grant_permissions(
        LEAD,
        [
            {"sign": "+", "node": ["tools", "run"]},
            path_entry("+", "write", sandboxed.project),
            path_entry("-", "write", core),
        ],
    )

    result = sandboxed.tools(LEAD).run(
        ["sh", "-c", "touch open.txt && echo ok && touch fora/core/closed.txt"],
        cwd=str(sandboxed.project),
    )

    assert result["stdout"].strip() == "ok"
    assert result["exit_code"] != 0
    assert (sandboxed.project / "open.txt").exists()
    assert not (core / "closed.txt").exists()


@linux
def test_commands_see_only_what_the_member_may_read(sandboxed: World) -> None:
    other = sandboxed.workspace(REVIEWER)
    (other / "plan.md").write_text("Hidden plan.\n")
    (sandboxed.project / "notes.md").write_text("Project notes.\n")
    sandboxed.tools(OWNER).grant_permissions(
        LEAD, [{"sign": "+", "node": ["tools", "run"]}]
    )
    lead = sandboxed.tools(LEAD)
    script = (
        f"test -e {other / 'plan.md'} && echo other; "
        f"test -e {sandboxed.root / 'fora.sqlite3'} && echo database; "
        f"test -e {sandboxed.project / 'notes.md'} && echo project; "
        "test -e /usr/bin/env && echo system; "
        "test -e workspace && echo own"
    )

    before = lead.run(["sh", "-c", script])["stdout"].split()
    sandboxed.tools(OWNER).grant_permissions(
        LEAD,
        [
            {"sign": "+", "node": ["workspace", "read", str(REVIEWER)]},
            path_entry("+", "read", sandboxed.project),
        ],
    )
    after = lead.run(["sh", "-c", script])["stdout"].split()

    assert before == ["system", "own"]
    assert after == ["other", "project", "system", "own"]


@linux
def test_the_raw_sandbox_keeps_a_protected_path_read_only(tmp_path: Path) -> None:
    writable = tmp_path / "project"
    protected = writable / "core"
    protected.mkdir(parents=True)
    execution = LocalExecution([str(writable)])
    try:
        result = execution.run(
            ["sh", "-c", "touch open.txt && echo ok && touch core/closed.txt"],
            cwd=str(writable),
            sandbox=Sandbox(
                Access.READ,
                (Mount(writable, Access.WRITE), Mount(protected, Access.READ)),
            ),
        )
    finally:
        execution.close()

    assert result.stdout.strip() == "ok"
    assert result.exit_code != 0
    assert not (protected / "closed.txt").exists()


@linux
def test_files_are_read_through_the_sandbox_of_a_member_without_grants(
    sandboxed: World,
) -> None:
    note = sandboxed.workspace(LEAD) / "note.txt"
    note.write_text("Mine.\n")
    execution = sandboxed.deps.execution.snapshot()
    sandbox = sandboxed.tools(LEAD).sandbox(execution)

    assert sandbox.root is Access.HIDDEN
    assert execution.read_file(str(note), 100, sandbox=sandbox) == b"Mine.\n"


def test_commands_refuse_to_run_while_a_protected_path_is_missing(
    world: World,
) -> None:
    world.tools(OWNER).grant_permissions(
        LEAD,
        [
            {"sign": "+", "node": ["tools", "run"]},
            {"sign": "+", "node": ["library", "write"]},
            {"sign": "-", "node": ["library", "write", "AGENTS.md"]},
        ],
    )

    with pytest.raises(DomainError) as error:
        world.tools(LEAD).run(["true"])

    assert error.value.code == ErrorCode.SANDBOX_UNAVAILABLE
    assert "AGENTS.md" in str(error.value)
    assert not (world.root / "library" / "AGENTS.md").exists()
    world.tools(OWNER).write_library("AGENTS.md", "Rules.\n")
    assert world.tools(LEAD).run(["true"])["exit_code"] == 0


@linux
def test_commands_run_under_a_broad_grant_with_fora_data_hidden(
    sandboxed: World,
) -> None:
    lead_holds_everything_except_specs(sandboxed)
    library = sandboxed.root / "library"
    script = (
        f"test -e {sandboxed.root / 'fora.sqlite3'} && echo database; "
        f"touch {library / 'rules' / 'flow.md'} && echo rules; "
        f"touch {library / 'specs' / 'context.md'} 2>/dev/null && echo specs; "
        f"touch {sandboxed.project / 'notes.md'} && echo project"
    )

    result = sandboxed.tools(LEAD).run(["sh", "-c", script])

    assert result["stdout"].split() == ["rules", "project"]
    assert not (library / "specs" / "context.md").exists()


@linux
def test_a_grant_on_a_symlink_does_not_open_where_it_points(
    sandboxed: World,
) -> None:
    library = sandboxed.root / "library"
    (library / "drafts").symlink_to(library / "rules")
    sandboxed.tools(OWNER).grant_permissions(
        LEAD,
        [
            {"sign": "+", "node": ["tools", "run"]},
            {"sign": "+", "node": ["library", "write", "drafts"]},
        ],
    )
    lead = sandboxed.tools(LEAD)

    result = lead.run(
        ["sh", "-c", f"echo started; touch {library / 'drafts' / 'x.md'} && echo wrote"]
    )

    assert result["stdout"].split() == ["started"], result["stderr"]
    assert not (library / "rules" / "x.md").exists()
    denied(lambda: lead.write_library("drafts/x.md", "Mine.\n"))


def test_library_exclusions_cover_whole_branches_and_real_paths(
    world: World,
) -> None:
    library = world.root / "library"
    (library / "docs" / "secret").mkdir(parents=True)
    (library / "docs" / "secret" / "plan.md").write_text("Plan.\n")
    (library / "docs" / "guide.md").write_text("Guide.\n")
    (library / "public").mkdir()
    (library / "public" / "link").symlink_to(library / "rules")
    world.tools(OWNER).grant_permissions(
        LEAD,
        [
            {"sign": "+", "node": ["library", "write", "docs"]},
            {"sign": "+", "node": ["library", "write", "public"]},
            {"sign": "-", "node": ["library", "write", "docs", "secret"]},
        ],
    )
    lead = world.tools(LEAD)

    denied(lambda: lead.delete_library("docs"))
    denied(lambda: lead.move_library("docs", "public/docs"))
    denied(lambda: lead.write_library("public/link/flow.md", "Mine.\n"))
    lead.delete_library("public/link")
    lead.move_library("docs/guide.md", "public/guide.md")

    assert (library / "docs" / "secret" / "plan.md").exists()
    assert (library / "rules").is_dir()
    assert not (library / "rules" / "flow.md").exists()
    assert (library / "public" / "guide.md").exists()


def test_a_workspace_grant_shows_the_workspace_and_nothing_else_of_that_agent(
    world: World,
) -> None:
    other = world.workspace(REVIEWER)
    (other / "private").mkdir()
    (other / "private" / "draft.md").write_text("Draft.\n")
    (other / "notes.md").write_text("Notes.\n")
    world.tools(OWNER).grant_permissions(
        LEAD,
        [
            {"sign": "+", "node": ["workspace", "read", str(REVIEWER)]},
            {"sign": "-", "node": ["workspace", "read", str(REVIEWER), "private"]},
        ],
    )
    lead = world.tools(LEAD)
    sandbox = lead.sandbox(world.deps.execution.snapshot())
    agent = (world.root / "agents" / str(REVIEWER)).resolve()

    listed = [item["path"] for item in lead.list_workspace(agent_id=REVIEWER)]
    assert "notes.md" in listed
    assert not [item for item in listed if item.startswith("private")]
    denied(lambda: lead.read_workspace("private/draft.md", agent_id=REVIEWER))
    assert sandbox.access(agent / "workspace" / "notes.md") is Access.READ
    assert sandbox.access(agent / "workspace" / "private") is Access.HIDDEN
    assert sandbox.access(agent / "history.sqlite3") is Access.HIDDEN


def test_reading_the_workspace_of_an_unknown_member_creates_nothing(
    world: World,
) -> None:
    with pytest.raises(DomainError) as error:
        world.tools(LEAD).list_workspace(agent_id=99)

    assert error.value.code == ErrorCode.NOT_FOUND
    assert not (world.root / "agents" / "99").exists()


def test_a_broken_execution_setup_still_reports_read_limits() -> None:
    manager = ExecutionManager(
        settings={"read_directories": "not a list"}, enforce=False
    )
    try:
        status = manager.status()
    finally:
        manager.close()

    assert status["error"]
    assert status["restricts_reads"] is sys.platform.startswith(("linux", "darwin"))


def test_editing_works_when_the_whole_machine_is_writable(world: World) -> None:
    world.deps.execution.configure({"write_directories": ["/"]}, lambda _: None)
    world.tools(OWNER).grant_permissions(
        LEAD, [{"sign": "+", "node": ["files", "write"]}]
    )

    world.tools(LEAD).edit(
        str(world.project / "new.md"),
        [{"old_text": "", "new_text": "New.\n"}],
        create=True,
    )

    assert (world.project / "new.md").read_text() == "New.\n"


def test_readable_directories_are_checked_when_saved(world: World) -> None:
    with pytest.raises(DomainError) as error:
        world.deps.execution.configure(
            {"read_directories": ["relative/path"]}, lambda _: None
        )

    assert error.value.code == ErrorCode.INVALID_DIRECTORY
    assert "Readable" in str(error.value)


def test_unusable_readable_directories_are_reported_at_startup() -> None:
    manager = ExecutionManager(
        settings={"read_directories": ["relative/path"]},
        enforce=False,
        tolerant=True,
    )
    try:
        status = manager.status()
    finally:
        manager.close()

    assert status["unusable_read_directories"] == [
        {"path": "relative/path", "reason": ErrorCode.INVALID_DIRECTORY}
    ]


def test_sandboxed_helpers_can_import_fora() -> None:
    source = Path(fora.__file__).resolve().parent.parent

    assert str(source) in interpreter_directories()


def test_viewing_a_hidden_file_is_refused(world: World) -> None:
    other = world.workspace(REVIEWER) / "shot.png"
    other.write_bytes(b"not really an image")

    denied(lambda: world.tools(LEAD).view_image(str(other)))


def test_the_environment_lists_what_this_member_can_write(world: World) -> None:
    lead_holds_everything_except_specs(world)
    execution = world.deps.execution.snapshot()

    text = execution.describe_environment((), world.tools(LEAD).sandbox(execution))

    assert str((world.root / "library" / "specs").resolve()) in text
    assert "Read-only inside them:" in text
