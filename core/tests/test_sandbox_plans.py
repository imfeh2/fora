from __future__ import annotations

import itertools
import os
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

from fora.adapters.execution.local import LocalExecution
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
    environment = LocalExecution([], SYSTEM)
    try:
        yield environment
    finally:
        environment.close()


def plan(
    root: Access,
    levels: dict[Path, Access],
    execution: LocalExecution,
) -> Sandbox:
    # 和 Fora 生成的计划一样，只在权限变化的地方放挂载点
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
    links = execution.read_links if root is Access.HIDDEN else ()
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
    # 和 uv 的布局一样：虚拟环境里的链接指向一个版本目录链接，再指向真实目录
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
