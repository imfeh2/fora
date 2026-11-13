from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from fora.core.blocks import Block, BlockKind
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.ports.agent import HistoryStore, WindowBlock

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
    window: int
    block: int
    kind: BlockKind
    snippet: str


@dataclass(frozen=True)
class BlockEntry:
    block: int
    kind: BlockKind
    length: int
    preview: str


@dataclass(frozen=True)
class WindowBlocks:
    window: int
    block_count: int
    blocks: tuple[BlockEntry, ...]
    next_offset: int | None


@dataclass(frozen=True)
class BlockText:
    window: int
    block: int
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
                item.window, item.position, item.block.kind, self._snippet(item, query)
            )
            for item in found[:SEARCH_LIMIT]
        )
        return hits, offset + SEARCH_LIMIT if len(found) > SEARCH_LIMIT else None

    def list(self, window: int | None = None, offset: int = 0) -> WindowBlocks:
        window = self._window(window)
        _check_number(offset, "offset")
        count = self._store.block_count(self._agent_id, window)
        entries = []
        for item in self._store.window_blocks(
            self._agent_id, window, offset=offset, limit=LIST_LIMIT
        ):
            text = self._render(item.block)
            entries.append(
                BlockEntry(
                    item.position,
                    item.block.kind,
                    len(text),
                    _shorten(_line(text), PREVIEW_LENGTH),
                )
            )
        end = offset + LIST_LIMIT
        return WindowBlocks(window, count, tuple(entries), end if end < count else None)

    def read(self, block: int, window: int | None = None, offset: int = 0) -> BlockText:
        window = self._window(window)
        _check_number(block, "block")
        _check_number(offset, "offset")
        found = self._store.window_blocks(self._agent_id, window, offset=block, limit=1)
        if not found or found[0].position != block:
            raise DomainError(
                ErrorCode.NOT_FOUND, f"Window {window} has no block {block}"
            )
        item = found[0]
        text = self._render(item.block)
        if offset > len(text):
            raise DomainError(
                ErrorCode.INVALID_OFFSET, "History offset exceeds the block length"
            )
        end = offset + READ_LIMIT
        return BlockText(
            window,
            block,
            item.block.kind,
            text[offset:end],
            offset,
            len(text),
            end if end < len(text) else None,
        )

    def _window(self, window: int | None) -> int:
        current = self._store.window(self._agent_id).number
        if window is None:
            return current
        _check_number(window, "window")
        if not 1 <= window <= current:
            raise DomainError(ErrorCode.NOT_FOUND, f"Window {window} does not exist")
        return window

    def _snippet(self, item: WindowBlock, query: str) -> str:
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
