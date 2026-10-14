from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass


@dataclass(frozen=True)
class UsageRequest:
    ordinal: int
    request_id: str
    started_at: str
    model_json: str
    usage_json: str | None
    metadata_json: str
    completed_at: str | None
    saved: bool


@dataclass(frozen=True)
class UsageTurn:
    agent_id: int
    sequence: int
    live_revision: int
    status: str
    requests: tuple[UsageRequest, ...]


@dataclass(frozen=True)
class UsageObservation:
    runtime_epoch: str
    turns: tuple[UsageTurn, ...] = ()

    @property
    def versions(self) -> tuple[tuple[int, int, int], ...]:
        return tuple(
            sorted(
                (turn.agent_id, turn.sequence, turn.live_revision)
                for turn in self.turns
            )
        )


class UsageCache:
    @classmethod
    def current(cls, name: str) -> UsageCache:
        caches = _usage_caches.get()
        return caches[name] if caches is not None else cls()

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._key: str | None = None
        self._value: str | None = None

    def obtain(self, key: str, build: Callable[[], str]) -> str:
        with self._lock:
            if self._key == key:
                assert self._value is not None
                return self._value
            value = build()
            self._key = key
            self._value = value
            return value

    def clear(self) -> None:
        with self._lock:
            self._key = None
            self._value = None


_usage_caches: ContextVar[dict[str, UsageCache] | None] = ContextVar(
    "usage_caches", default=None
)


@contextmanager
def usage_session() -> Iterator[None]:
    caches = {
        name: UsageCache() for name in ("usage", "organization", "detail", "history")
    }
    token = _usage_caches.set(caches)
    try:
        yield
    finally:
        _usage_caches.reset(token)
        for cache in caches.values():
            cache.clear()
