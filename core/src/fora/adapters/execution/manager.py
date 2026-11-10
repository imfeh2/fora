from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from fora.adapters.execution.local import LocalExecution
from fora.adapters.execution.platforms import backend_type
from fora.adapters.sandbox.paths import default_read_directories
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.ports.execution import EditResult, ExecutionEnvironment, RunResult, Sandbox

SETTINGS = frozenset({"write_directories", "read_directories"})


def read_setting(value: object) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise DomainError(
            ErrorCode.INVALID_DIRECTORY, "Readable directories must be a list of paths"
        )
    return list(value)


def setting_directories(value: object) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise DomainError(
            ErrorCode.INVALID_DIRECTORY, "Writable directories must be a list of paths"
        )
    return list(value)


class BoundExecution:
    def __init__(self, lookup: Callable[[], ExecutionEnvironment]) -> None:
        self._lookup = lookup

    @property
    def skipped(self) -> tuple[tuple[str, str], ...]:
        return self._lookup().skipped

    @property
    def write_directories(self) -> tuple[str, ...]:
        return self._lookup().write_directories

    @property
    def read_directories(self) -> tuple[str, ...]:
        return self._lookup().read_directories

    @property
    def read_links(self) -> tuple[tuple[Path, str], ...]:
        return self._lookup().read_links

    def describe_environment(
        self,
        labeled: Sequence[tuple[str, str]] = (),
        sandbox: Sandbox | None = None,
    ) -> str:
        return self._lookup().describe_environment(labeled, sandbox)

    def resolve_path(self, value: str, *, base: str) -> str:
        return self._lookup().resolve_path(value, base=base)

    def read_file(
        self,
        path: str,
        max_bytes: int,
        *,
        timeout: int | None = None,
        sandbox: Sandbox | None = None,
    ) -> bytes:
        return self._lookup().read_file(
            path, max_bytes, timeout=timeout, sandbox=sandbox
        )

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: str,
        timeout: int | None = None,
        sandbox: Sandbox | None = None,
    ) -> RunResult:
        return self._lookup().run(argv, cwd=cwd, timeout=timeout, sandbox=sandbox)

    def edit(
        self,
        path: str,
        edits: Sequence[Mapping[str, object]],
        *,
        write_directories: Sequence[str] | None = None,
        create: bool = False,
    ) -> EditResult:
        return self._lookup().edit(
            path,
            edits,
            write_directories=write_directories,
            create=create,
        )


class ExecutionManager:
    def __init__(
        self,
        *,
        settings: dict[str, object] | None = None,
        enforce: bool = True,
        tolerant: bool = False,
    ) -> None:
        self._enforce = enforce
        self._lock = threading.RLock()
        self._closed = False
        self._environment: LocalExecution | None = None
        self._directories: list[str] = []
        self._reads: list[str] | None = None
        self._error: str | None = None
        stored = settings or {}
        try:
            if set(stored) - SETTINGS:
                raise DomainError(
                    ErrorCode.INVALID_SETTING, "Unknown execution setting"
                )
            self._directories = setting_directories(stored.get("write_directories"))
            self._reads = read_setting(stored.get("read_directories"))
            self._environment = LocalExecution(
                self._directories,
                self._reads,
                enforce=self._enforce,
                tolerant=tolerant,
            )
        except DomainError as error:
            self._error = str(error)

    def snapshot(self) -> ExecutionEnvironment:
        def lookup() -> ExecutionEnvironment:
            with self._lock:
                if self._closed:
                    raise DomainError(
                        ErrorCode.EXECUTION_CLOSED, "Execution environment is closed"
                    )
                if self._environment is None:
                    raise DomainError(
                        ErrorCode.EXECUTION_UNAVAILABLE,
                        self._error or "Execution environment is unavailable",
                    )
                return self._environment

        return BoundExecution(lookup)

    def status(self) -> dict[str, Any]:
        with self._lock:
            skipped = self._environment.skipped if self._environment else ()
            skipped_reads = self._environment.skipped_reads if self._environment else ()
            return {
                "write_directories": list(self._directories),
                "read_directories": (
                    list(default_read_directories())
                    if self._reads is None
                    else list(self._reads)
                ),
                "restricts_reads": backend_type().restricts_reads,
                "unusable_write_directories": [
                    {"path": path, "reason": reason} for path, reason in skipped
                ],
                "unusable_read_directories": [
                    {"path": path, "reason": reason} for path, reason in skipped_reads
                ],
                "error": self._error,
            }

    def configure(
        self, values: dict[str, Any], persist: Callable[[dict[str, object]], None]
    ) -> dict[str, Any]:
        if set(values) - SETTINGS:
            raise DomainError(ErrorCode.INVALID_SETTING, "Unknown execution setting")
        with self._lock:
            if self._closed:
                raise DomainError(
                    ErrorCode.EXECUTION_CLOSED, "Execution environment is closed"
                )
            directories = setting_directories(
                values.get("write_directories", self._directories)
            )
            reads = (
                read_setting(values["read_directories"])
                if "read_directories" in values
                else self._reads
            )
            candidate = LocalExecution(directories, reads, enforce=self._enforce)
            configured: dict[str, object] = {
                "write_directories": list(candidate.write_directories)
            }
            if reads is not None:
                configured["read_directories"] = reads
            try:
                persist(configured)
            except Exception:
                candidate.close()
                raise
            if self._environment is None:
                self._environment = candidate
            else:
                self._environment.apply_configuration(candidate)
                candidate.close()
            self._directories = list(candidate.write_directories)
            self._reads = reads
            self._error = None
        return self.status()

    def close(self, *, deadline: float | None = None) -> None:
        deadline = time.monotonic() + 5 if deadline is None else deadline
        self._closed = True
        if not self._lock.acquire(timeout=max(0, deadline - time.monotonic())):
            raise TimeoutError("Execution manager is busy")
        try:
            environment = self._environment
        finally:
            self._lock.release()
        if environment is not None:
            environment.close(deadline=deadline)
