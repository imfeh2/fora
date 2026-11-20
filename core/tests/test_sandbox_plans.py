from __future__ import annotations

import itertools
import os
import signal
import sys
import time
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path

import pytest

from fora.adapters.execution.local import LocalExecution
from fora.adapters.sandbox.commands import SANDBOX_MARKER
from fora.adapters.sandbox.paths import symlinks_on
from fora.ports.execution import Access, Mount, Sandbox

pytestmark = pytest.mark.skipif(
    sys.platform != "linux", reason="the bubblewrap sandbox runs on Linux"
)

SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]
LEVELS = ("outer", "middle", "inner")
STATES = (Access.HIDDEN, Access.READ, Access.WRITE)


@pytest.fixture(scope="module")
def execution() -> Iterator[LocalExecution]:
    environment = LocalExecution()
    try:
        yield environment
    finally:
        environment.close()


def plan(
    root: Access,
    levels: dict[Path, Access],
    execution: LocalExecution,
) -> Sandbox:
    mounts = (
        [Mount(Path(item).resolve(), Access.READ) for item in SYSTEM]
        if root is Access.HIDDEN
        else []
    )
    inherited = root
    for path, state in levels.items():
        if state != inherited:
            mounts.append(Mount(path, state))
        inherited = state
    links = execution.links if root is Access.HIDDEN else ()
    return Sandbox(root, tuple(mounts), links)


@pytest.mark.parametrize("root", STATES, ids=lambda root: f"root-{root.name.lower()}")
@pytest.mark.parametrize(
    "states",
    list(itertools.product(STATES, repeat=len(LEVELS))),
    ids=lambda states: "-".join(state.name.lower() for state in states),
)
def test_commands_see_exactly_what_the_plan_allows(
    tmp_path: Path,
    execution: LocalExecution,
    root: Access,
    states: tuple[Access, ...],
) -> None:
    levels: dict[Path, Access] = {}
    current = tmp_path.resolve()
    for name, state in zip(LEVELS, states, strict=True):
        current = current / name
        current.mkdir()
        (current / "file").write_text("content\n")
        levels[current] = state
    script = "; ".join(
        f"test -e {path / 'file'} && echo {path.name}:seen; "
        f"touch {path / 'new'} 2>/dev/null && echo {path.name}:wrote"
        for path in levels
    )

    result = execution.run(
        ["sh", "-c", script], cwd="/usr", sandbox=plan(root, levels, execution)
    )

    expected = [
        f"{path.name}:{verb}"
        for path, state in levels.items()
        for verb, needed in (("seen", Access.READ), ("wrote", Access.WRITE))
        if state >= needed
    ]
    assert result.stdout.split() == expected, result.stderr
    for path, state in levels.items():
        assert (path / "new").exists() is (state is Access.WRITE)


@pytest.mark.skipif(
    os.environ.get(SANDBOX_MARKER) == "1",
    reason="inside a sandbox, commands share the enclosing process namespace",
)
@pytest.mark.parametrize("root", STATES, ids=lambda root: f"root-{root.name.lower()}")
def test_commands_cannot_see_processes_outside_the_sandbox(
    execution: LocalExecution, root: Access
) -> None:
    result = execution.run(
        ["sh", "-c", f"echo started; test -e /proc/{os.getpid()} && echo host"],
        cwd="/usr",
        sandbox=plan(root, {}, execution),
    )

    assert result.stdout.split() == ["started"], result.stderr


def test_a_program_reached_through_chained_links_starts_in_a_hidden_root(
    tmp_path: Path, execution: LocalExecution
) -> None:
    real = tmp_path.resolve() / "cpython-3.13.18"
    real.mkdir()
    program = real / "tool"
    program.write_text("#!/bin/sh\necho ran\n")
    program.chmod(0o755)
    (tmp_path / "cpython-3.13").symlink_to(real)
    venv = tmp_path.resolve() / "venv"
    venv.mkdir()
    (venv / "tool").symlink_to(tmp_path.resolve() / "cpython-3.13" / "tool")
    base = plan(Access.HIDDEN, {}, execution)
    sandbox = Sandbox(
        Access.HIDDEN,
        (*base.mounts, Mount(real, Access.READ), Mount(venv, Access.READ)),
        (*base.links, *symlinks_on(venv / "tool")),
    )

    result = execution.run([str(venv / "tool")], cwd="/usr", sandbox=sandbox)

    assert result.stdout.strip() == "ran", result.stderr


@pytest.mark.parametrize("root", STATES, ids=lambda root: f"root-{root.name.lower()}")
def test_a_sandboxed_command_can_start_another_sandbox(
    execution: LocalExecution, root: Access
) -> None:
    script = (
        "import subprocess, sys\n"
        "from fora.adapters.sandbox.commands import linux_command\n"
        "from fora.ports.execution import Access, Sandbox\n"
        "command = linux_command(['echo', 'inner'], '/usr', Sandbox(Access.READ, ()))\n"
        "result = subprocess.run(command, capture_output=True, text=True)\n"
        "sys.stdout.write(result.stdout + result.stderr)\n"
    )
    base = plan(root, {}, execution)
    readable = {
        Path("/tmp"),
        Path(sys.base_prefix),
        Path(sys.prefix),
        *map(Path, filter(None, sys.path)),
    }
    sandbox = Sandbox(
        base.root,
        (*base.mounts, *(Mount(path.resolve(), Access.READ) for path in readable)),
        (*base.links, *symlinks_on(Path(sys.executable))),
    )

    result = execution.run([sys.executable, "-c", script], cwd="/usr", sandbox=sandbox)

    assert result.stdout.split() == ["inner"], result.stderr


@pytest.mark.parametrize("root", STATES, ids=lambda root: f"root-{root.name.lower()}")
def test_a_hostpid_command_shares_host_processes_and_leaves_background_ones_running(
    execution: LocalExecution, root: Access
) -> None:
    shared = replace(plan(root, {}, execution), hostpid=True)
    result = execution.run(
        [
            "sh",
            "-c",
            (
                f"test -e /proc/{os.getpid()} && echo host; "
                "setsid sleep 60 </dev/null >/dev/null 2>&1 & echo $!"
            ),
        ],
        cwd="/usr",
        sandbox=shared,
    )

    host, pid = result.stdout.split()
    try:
        assert host == "host", result.stderr
        os.kill(int(pid), 0)
    finally:
        os.kill(int(pid), signal.SIGKILL)


def test_a_background_process_outlives_its_command_and_other_commands_see_it(
    execution: LocalExecution,
) -> None:
    sandbox = plan(Access.READ, {}, execution)
    started = execution.run(
        ["sh", "-c", "setsid sleep 60 </dev/null >/dev/null 2>&1 & echo $!"],
        cwd="/usr",
        sandbox=sandbox,
    )
    pid = started.stdout.strip()

    seen = execution.run(
        ["sh", "-c", f"test -e /proc/{pid} && echo alive; kill {pid}"],
        cwd="/usr",
        sandbox=sandbox,
    )

    assert seen.stdout.split() == ["alive"], seen.stderr


def _running(marker: str) -> bool:
    for entry in Path("/proc").iterdir():
        try:
            if marker in (entry / "cmdline").read_bytes().decode(errors="replace"):
                return True
        except OSError:
            continue
    return False


def _settles(marker: str, running: bool) -> bool:
    deadline = time.monotonic() + 5
    while _running(marker) is not running and time.monotonic() < deadline:
        time.sleep(0.05)
    return _running(marker) is running


@pytest.mark.skipif(
    os.environ.get(SANDBOX_MARKER) == "1",
    reason="inside a sandbox, commands share the enclosing process namespace",
)
def test_closing_the_execution_environment_ends_background_processes() -> None:
    environment = LocalExecution()
    marker = f"{os.getpid() % 10000 + 50000}"
    try:
        environment.run(
            ["sh", "-c", f"setsid sleep {marker} </dev/null >/dev/null 2>&1 &"],
            cwd="/usr",
            sandbox=plan(Access.READ, {}, environment),
        )
        assert _settles(f"sleep\0{marker}", running=True)
    finally:
        environment.close()

    assert _settles(f"sleep\0{marker}", running=False)
