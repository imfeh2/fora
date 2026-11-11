from __future__ import annotations

import os
import shutil
from collections.abc import Sequence
from pathlib import Path, PurePath

from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.ports.execution import Access, Mount, Sandbox

BUBBLEWRAP_CANDIDATES = ("/usr/bin/bwrap", "/bin/bwrap")
SANDBOX_EXEC = "/usr/bin/sandbox-exec"


def bubblewrap_executable() -> str:
    for candidate in BUBBLEWRAP_CANDIDATES:
        if Path(candidate).is_file():
            return candidate
    found = shutil.which("bwrap")
    if found is None:
        raise DomainError(
            ErrorCode.SANDBOX_UNAVAILABLE,
            "bubblewrap is required for filesystem write protection",
        )
    return str(Path(found).resolve())


def linux_command(
    argv: Sequence[str],
    cwd: Path | str,
    sandbox: Sandbox,
    *,
    bwrap: str | None = None,
    root: bool | None = None,
) -> list[str]:
    if root is None:
        root = hasattr(os, "geteuid") and os.geteuid() == 0
    command = [bwrap or bubblewrap_executable(), "--die-with-parent"]
    if sandbox.root is not Access.HIDDEN:
        command.extend(("--ro-bind", "/", "/"))
    # 隔离进程：否则宿主机上的进程和它们的命令行参数在沙箱里都能看到
    command.extend(
        ("--dev", "/dev", "--proc", "/proc", "--unshare-user", "--unshare-pid")
    )
    if sandbox.root is Access.HIDDEN:
        for link, target in sandbox.links:
            command.extend(("--symlink", target, link.as_posix()))
    # 隐藏目录里面可能还要挂可见的子目录，所以等全部挂载完成后再把它设成只读；
    # 根目录隐藏时，作为根目录的内存文件系统也一样
    remounts: list[str] = ["--remount-ro", "/"] if sandbox.root is Access.HIDDEN else []
    for mount in sandbox.ordered():
        rendered = mount.path.as_posix()
        if mount.access is Access.HIDDEN:
            if mount.path.is_dir():
                command.extend(("--tmpfs", rendered))
                remounts.extend(("--remount-ro", rendered))
            elif mount.path.exists():
                command.extend(("--ro-bind", "/dev/null", rendered))
        elif mount.path.exists():
            command.extend(
                (
                    "--bind" if mount.access is Access.WRITE else "--ro-bind",
                    rendered,
                    rendered,
                )
            )
    command.extend(remounts)
    working = cwd.as_posix() if isinstance(cwd, PurePath) else str(cwd)
    command.extend(("--chdir", working, "--cap-drop", "ALL"))
    if root:
        command.extend(("--cap-add", "CAP_SETFCAP"))
    command.extend(("--", *argv))
    return command


def _denials(
    sandbox: Sandbox,
    names: dict[Path, str],
    operation: str,
    threshold: Access,
    exempt: str,
) -> list[str]:
    mounts = sandbox.ordered()
    regions: list[Mount | None] = [None] if sandbox.root < threshold else []
    regions.extend(
        mount
        for mount in mounts
        if mount.access < threshold and sandbox.inherited(mount.path) >= threshold
    )
    rules = []
    for region in regions:
        reopened = [
            mount
            for mount in mounts
            if mount.access >= threshold
            and sandbox.inherited(mount.path) < threshold
            and (region is None or mount.path.is_relative_to(region.path))
        ]
        lines = [
            f'    (require-not (subpath (param "{names[item.path]}")))'
            for item in reopened
        ]
        if region is None:
            lines.insert(0, f"    (require-not {exempt})")
        else:
            lines.insert(0, f'    (subpath (param "{names[region.path]}"))')
        rules.append(f"(deny {operation}\n  (require-all\n" + "\n".join(lines) + "))")
    return rules


def macos_profile(sandbox: Sandbox) -> tuple[str, list[str]]:
    names = {
        mount.path: f"PATH_{index}" for index, mount in enumerate(sandbox.ordered())
    }
    rules = [
        "(version 1)",
        "(allow default)",
        *_denials(sandbox, names, "file-write*", Access.WRITE, '(literal "/dev/null")'),
        # 只禁止读取内容；查看文件信息仍然允许，否则可读目录的上级目录无法解析路径
        *_denials(sandbox, names, "file-read-data", Access.READ, '(subpath "/dev")'),
        *(
            "(deny file-write-unlink\n"
            "  (require-all\n"
            f'    (literal (param "{names[path]}"))\n'
            "    (vnode-type DIRECTORY)))"
            for path in sandbox.paths(Access.WRITE)
        ),
    ]
    parameters = [f"-D{name}={path.as_posix()}" for path, name in names.items()]
    return "\n".join(rules), parameters


def macos_command(argv: Sequence[str], sandbox: Sandbox) -> list[str]:
    profile, parameters = macos_profile(sandbox)
    return [SANDBOX_EXEC, "-p", profile, *parameters, "--", *argv]


def windows_command(
    sid: str, argv: Sequence[str], entrypoint: Sequence[str]
) -> list[str]:
    return [*entrypoint, "--windows-write-sandbox", sid, "--", *argv]
