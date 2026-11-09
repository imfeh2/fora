from __future__ import annotations

from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.ports.agent import AgentRun, HistorySlice, HistoryStore

READ_LIMIT = 2048
SEARCH_LIMIT = 20
MAX_SQLITE_INTEGER = 2**63 - 1


def _check_offset(offset: int | None) -> None:
    if offset is not None and (
        isinstance(offset, bool) or not isinstance(offset, int) or offset < 0
    ):
        raise DomainError(
            ErrorCode.INVALID_OFFSET,
            "History offset must be a non-negative integer",
        )
    if offset is not None and offset > MAX_SQLITE_INTEGER:
        raise DomainError(
            ErrorCode.INVALID_OFFSET, "History offset exceeds the supported range"
        )


class History:
    def __init__(self, store: HistoryStore, agent_id: int) -> None:
        self._store = store
        self._agent_id = agent_id

    def runs(self, *, limit: int = 50) -> tuple[AgentRun, ...]:
        return self._store.runs(self._agent_id, limit=limit)

    def search(
        self, query: str, offset: int = 0
    ) -> tuple[tuple[AgentRun, ...], int | None]:
        _check_offset(offset)
        found = self._store.search_runs(
            self._agent_id, query, limit=SEARCH_LIMIT + 1, offset=offset
        )
        return found[:SEARCH_LIMIT], (
            offset + SEARCH_LIMIT if len(found) > SEARCH_LIMIT else None
        )

    def read(self, sequence: int, offset: int | None = None) -> HistorySlice | None:
        _check_offset(offset)
        return self._store.read_run_slice(self._agent_id, sequence, offset, READ_LIMIT)
