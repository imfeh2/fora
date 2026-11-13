from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from fora.core.blocks import Block, BlockKind
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.ports.agent import AgentRun, HistoryStore, TurnBlock

SEARCH_LIMIT = 20
LIST_LIMIT = 50
READ_LIMIT = 8000
PREVIEW_LENGTH = 160
SNIPPET_MARGIN = 80
MAX_SQLITE_INTEGER = 2**63 - 1


def _check_number(value: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise DomainError(
            ErrorCode.INVALID_OFFSET, f"History {name} must be a non-negative integer"
        )
    if value > MAX_SQLITE_INTEGER:
        raise DomainError(
            ErrorCode.INVALID_OFFSET, f"History {name} exceeds the supported range"
        )


def _line(text: str) -> str:
    return " ".join(text.split())


def _shorten(text: str, length: int) -> str:
    return text if len(text) <= length else text[: length - 1] + "…"


@dataclass(frozen=True)
class BlockHit:
    sequence: int
    index: int
    kind: BlockKind
    snippet: str


@dataclass(frozen=True)
class BlockEntry:
    index: int
    kind: BlockKind
    length: int
    preview: str


@dataclass(frozen=True)
class TurnBlocks:
    run: AgentRun
    blocks: tuple[BlockEntry, ...]
    next_offset: int | None


@dataclass(frozen=True)
class BlockText:
    sequence: int
    index: int
    kind: BlockKind
    text: str
    offset: int
    total_length: int
    next_offset: int | None


class History:
    def __init__(
        self, store: HistoryStore, agent_id: int, render: Callable[[Block], str]
    ) -> None:
        self._store = store
        self._agent_id = agent_id
        self._render = render

    def search(
        self, query: str, offset: int = 0
    ) -> tuple[tuple[BlockHit, ...], int | None]:
        _check_number(offset, "offset")
        found = self._store.search_blocks(
            self._agent_id, query, limit=SEARCH_LIMIT + 1, offset=offset
        )
        hits = tuple(
            BlockHit(
                item.sequence, item.index, item.block.kind, self._snippet(item, query)
            )
            for item in found[:SEARCH_LIMIT]
        )
        return hits, offset + SEARCH_LIMIT if len(found) > SEARCH_LIMIT else None

    def list(self, sequence: int, offset: int = 0) -> TurnBlocks:
        _check_number(sequence, "turn")
        _check_number(offset, "offset")
        run = self._run(sequence)
        blocks = self._store.turn_blocks(self._agent_id, sequence)
        entries = []
        for item in blocks[offset : offset + LIST_LIMIT]:
            text = self._render(item.block)
            entries.append(
                BlockEntry(
                    item.index,
                    item.block.kind,
                    len(text),
                    _shorten(_line(text), PREVIEW_LENGTH),
                )
            )
        return TurnBlocks(
            run,
            tuple(entries),
            offset + LIST_LIMIT if len(blocks) > offset + LIST_LIMIT else None,
        )

    def read(self, sequence: int, index: int, offset: int = 0) -> BlockText:
        _check_number(sequence, "turn")
        _check_number(index, "block")
        _check_number(offset, "offset")
        self._run(sequence)
        blocks = self._store.turn_blocks(self._agent_id, sequence)
        if index >= len(blocks):
            raise DomainError(
                ErrorCode.NOT_FOUND, f"Turn {sequence} has no block {index}"
            )
        block = blocks[index].block
        text = self._render(block)
        if offset > len(text):
            raise DomainError(
                ErrorCode.INVALID_OFFSET, "History offset exceeds the block length"
            )
        end = offset + READ_LIMIT
        return BlockText(
            sequence,
            index,
            block.kind,
            text[offset:end],
            offset,
            len(text),
            end if end < len(text) else None,
        )

    def _run(self, sequence: int) -> AgentRun:
        run = self._store.run(self._agent_id, sequence)
        if run is None:
            raise DomainError(ErrorCode.NOT_FOUND, f"Turn {sequence} does not exist")
        return run

    def _snippet(self, item: TurnBlock, query: str) -> str:
        text = _line(self._render(item.block))
        found = text.casefold().find(query.casefold())
        if found < 0:
            return _shorten(text, PREVIEW_LENGTH)
        start = max(found - SNIPPET_MARGIN, 0)
        end = found + len(query) + SNIPPET_MARGIN
        return (
            ("…" if start > 0 else "")
            + text[start:end]
            + ("…" if end < len(text) else "")
        )
