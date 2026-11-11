from __future__ import annotations

import time

from fora.adapters.execution.local import LocalExecution
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.ports.execution import ExecutionEnvironment


class ExecutionManager:
    def __init__(self, *, enforce: bool = True) -> None:
        self._closed = False
        self._environment = LocalExecution(enforce=enforce)

    def snapshot(self) -> ExecutionEnvironment:
        if self._closed:
            raise DomainError(
                ErrorCode.EXECUTION_CLOSED, "Execution environment is closed"
            )
        return self._environment

    def close(self, *, deadline: float | None = None) -> None:
        self._closed = True
        self._environment.close(
            deadline=time.monotonic() + 5 if deadline is None else deadline
        )
