from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import replace

from fora.ports.agent import (
    AgentRun,
    GenerationKey,
    GenerationMutation,
    GenerationUpdate,
    HistoryStore,
    ModelRequestHandle,
)
from fora.runtime.reminder import HistoryPersistenceError


class GenerationRecorder:
    def __init__(
        self,
        history: HistoryStore,
        run: AgentRun,
        notify: Callable[[str, dict[str, object]], None],
    ) -> None:
        self._history = history
        self._run = run
        self._notify = notify
        self._handles: set[ModelRequestHandle] = set()
        self._closed: set[ModelRequestHandle] = set()
        self._updates: dict[GenerationKey, GenerationUpdate] = {}
        self._pending: dict[GenerationKey, GenerationUpdate] = {}
        self._event: asyncio.Event | None = None
        self._finished = False

    def register(self, handle: ModelRequestHandle) -> None:
        if self._finished or handle in self._handles:
            raise ValueError("Generation request cannot be registered")
        self._handles.add(handle)

    def key(self, handle: ModelRequestHandle, part_index: int) -> GenerationKey:
        if handle not in self._handles:
            raise ValueError("Generation request was not recorded")
        if type(part_index) is not int or part_index < 0:
            raise ValueError("Invalid generation part index")
        return GenerationKey(
            self._run.agent_id,
            self._run.sequence,
            handle.ordinal,
            part_index,
            handle.request_id,
            self._run.run_id,
        )

    def update(
        self, handle: ModelRequestHandle, part_index: int, update: GenerationUpdate
    ) -> None:
        key = self.key(handle, part_index)
        if self._finished or handle in self._closed:
            return
        previous = self._updates.get(key)
        if previous is not None and (
            previous.status in ("failed", "interrupted")
            or (
                previous.status == "completed"
                and update.status == "generating"
                and not update.replace_part
            )
        ):
            return
        self._updates[key] = update
        self._pending[key] = update
        if previous is None or update.replace_part or update.status != "generating":
            self.flush(handle)
        elif self._event is not None:
            self._event.set()

    def _publish(self, mutation: GenerationMutation) -> None:
        part = mutation.part
        key = part.key
        self._notify(
            "turn.generation",
            {
                "agent_id": key.agent_id,
                "sequence": key.sequence,
                "ordinal": key.ordinal,
                "request_id": key.request_id,
                "run_id": key.run_id,
                "part_index": key.part_index,
                "revision": part.revision,
            },
        )
        preview = mutation.preview
        if preview is None:
            return
        targets = {
            target
            for target in (mutation.previous_discussion_id, preview.discussion_id)
            if target is not None
        }
        for discussion_id in sorted(targets):
            self._notify(
                "discussion.preview",
                {
                    "discussion_id": discussion_id,
                    "preview_id": preview.preview_id,
                    "revision": preview.revision,
                },
            )

    def flush(self, handle: ModelRequestHandle | None = None) -> None:
        for key, update in tuple(self._pending.items()):
            if handle is not None and (
                key.ordinal != handle.ordinal or key.request_id != handle.request_id
            ):
                continue
            try:
                mutation = self._history.generation.save(key, update)
            except Exception as error:
                raise HistoryPersistenceError(
                    "Could not save generation content"
                ) from error
            del self._pending[key]
            self._publish(mutation)

    def response(self, handle: ModelRequestHandle) -> None:
        for key, update in tuple(self._updates.items()):
            if key.ordinal == handle.ordinal and update.status == "generating":
                final = replace(update, status="completed")
                self._updates[key] = final
                self._pending[key] = final
        self.flush(handle)

    def finish(self, handle: ModelRequestHandle, error: str | None = None) -> None:
        if handle in self._closed:
            return
        for key, update in tuple(self._updates.items()):
            if key.ordinal != handle.ordinal:
                continue
            preview = self._history.generation.preview(key)
            failure = (
                None if preview is not None and preview.status == "sent" else error
            )
            if (
                failure is None
                and preview is not None
                and preview.status not in ("sent", "failed", "interrupted")
            ):
                failure = "The request ended without a confirmed send"
            if update.status in ("failed", "interrupted"):
                continue
            if failure is not None or update.status == "generating":
                final = replace(
                    update,
                    status="failed" if failure is not None else "completed",
                    error=failure,
                )
                self._updates[key] = final
                self._pending[key] = final
        self.flush(handle)
        self._closed.add(handle)

    def close(self, error: str | None = None) -> None:
        for handle in sorted(self._handles, key=lambda value: value.ordinal):
            self.finish(handle, error)
        self._finished = True
        self._updates.clear()

    async def _pump(self, event: asyncio.Event) -> None:
        while True:
            await event.wait()
            await asyncio.sleep(0.05)
            event.clear()
            self.flush()

    @asynccontextmanager
    async def session(self) -> AsyncIterator[None]:
        if self._event is not None or self._finished:
            raise ValueError("Generation session is unavailable")
        self._event = asyncio.Event()
        if self._pending:
            self._event.set()
        try:
            async with asyncio.TaskGroup() as tasks:
                pump = tasks.create_task(self._pump(self._event))
                try:
                    yield
                finally:
                    pump.cancel()
        except BaseExceptionGroup as error:
            if len(error.exceptions) == 1:
                raise error.exceptions[0]
            raise
        finally:
            self._event = None
