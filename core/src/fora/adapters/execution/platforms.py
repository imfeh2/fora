from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Sequence
from pathlib import Path

from fora.adapters.sandbox.commands import (
    SANDBOX_MARKER,
    linux_command,
    macos_command,
    namespace_command,
)
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.ports.execution import Sandbox


def entrypoint() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable]
    return [sys.executable, "-I", "-m", "fora"]


def dispatch_helper(argv: list[str]) -> int | None:
    if argv and argv[0] == "--read-file":
        from fora.adapters.execution.reading import dispatch_read_file

        return dispatch_read_file(argv[1:])
    return None


class ExecutionBackend:
    restricts_reads = False

    def __init__(self, enforce: bool) -> None:
        self._enforce = enforce
        self.name = sys.platform

    @property
    def isolates_processes(self) -> bool:
        return False

    def wrap(self, argv: Sequence[str], cwd: Path, sandbox: Sandbox) -> list[str]:
        raise DomainError(
            ErrorCode.SANDBOX_UNAVAILABLE,
            "Filesystem write protection is unavailable on this platform",
        )

    def spawn(
        self,
        argv: Sequence[str],
        cwd: Path,
        sandbox: Sandbox,
        *,
        piped_input: bool,
        input_data: bytes | None = None,
    ) -> subprocess.Popen[bytes]:
        command = self.wrap(argv, cwd, sandbox) if self._enforce else list(argv)
        return subprocess.Popen(
            command,
            cwd=cwd,
            stdin=subprocess.PIPE if piped_input else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )

    def terminate(self, process: subprocess.Popen[bytes]) -> None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def communicate(
        self, process: subprocess.Popen[bytes], data: bytes | None, timeout: float
    ) -> tuple[bytes, bytes]:
        return process.communicate(input=data, timeout=timeout)

    def cleanup(self, process: subprocess.Popen[bytes], *, deadline: float) -> None:
        self.terminate(process)
        process.communicate(timeout=max(0, deadline - time.monotonic()))

    def finish(self, process: subprocess.Popen[bytes]) -> None:
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()

    def close(self, *, deadline: float | None = None) -> None:
        pass


class LinuxBackend(ExecutionBackend):
    restricts_reads = True

    def __init__(self, enforce: bool) -> None:
        super().__init__(enforce)
        self._holder_lock = threading.Lock()
        self._holder: subprocess.Popen[bytes] | None = None
        self._namespace = 0

    @property
    def isolates_processes(self) -> bool:
        return self._enforce and os.environ.get(SANDBOX_MARKER) != "1"

    def wrap(self, argv: Sequence[str], cwd: Path, sandbox: Sandbox) -> list[str]:
        if sandbox.hostpid or not self.isolates_processes:
            return linux_command(argv, cwd, sandbox)
        return linux_command(argv, cwd, sandbox, namespace=self._shared_namespace())

    def _shared_namespace(self) -> int:
        with self._holder_lock:
            if self._holder is None or self._holder.poll() is not None:
                self._holder, self._namespace = _start_namespace()
            return self._namespace

    def close(self, *, deadline: float | None = None) -> None:
        with self._holder_lock:
            holder, self._holder = self._holder, None
        if holder is None:
            return
        deadline = time.monotonic() + 5 if deadline is None else deadline
        assert holder.stdin is not None
        holder.stdin.close()
        try:
            holder.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            holder.kill()
            holder.wait()
        finally:
            for stream in (holder.stdout, holder.stderr):
                if stream is not None:
                    stream.close()


def _start_namespace() -> tuple[subprocess.Popen[bytes], int]:
    reader, writer = os.pipe()
    try:
        holder = subprocess.Popen(
            namespace_command(writer),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(writer,),
            start_new_session=True,
        )
    finally:
        os.close(writer)
    with os.fdopen(reader, "rb") as info:
        report = info.read()
    assert holder.stdout is not None
    if not report or holder.stdout.readline() != b"ready\n":
        _, stderr = holder.communicate()
        raise DomainError(
            ErrorCode.SANDBOX_UNAVAILABLE,
            "Could not start the shared process namespace: "
            + stderr.decode("utf-8", "replace").strip(),
        )
    return holder, int(json.loads(report)["child-pid"])


class MacOSBackend(ExecutionBackend):
    restricts_reads = True

    def wrap(self, argv: Sequence[str], cwd: Path, sandbox: Sandbox) -> list[str]:
        return macos_command(argv, sandbox)


def backend_type() -> type[ExecutionBackend]:
    if sys.platform.startswith("linux"):
        return LinuxBackend
    if sys.platform == "darwin":
        return MacOSBackend
    return ExecutionBackend


def create_backend(enforce: bool) -> ExecutionBackend:
    return backend_type()(enforce)
