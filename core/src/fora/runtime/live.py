from __future__ import annotations

import threading
import uuid
from collections.abc import Callable
from dataclasses import replace

from fora.ports.agent import AgentRun, ModelRequestHandle
from fora.ports.live import LiveRequest, LiveRequestCoverage, LiveTool, LiveTurn


class LiveSnapshots:
    def __init__(self, emit: Callable[[str, dict[str, object]], None]) -> None:
        self.runtime_epoch = uuid.uuid4().hex
        self._emit = emit
        self._lock = threading.Lock()
        self._turns: dict[int, LiveTurn] = {}
        self._closed = False

    def capture(self, agent_id: int | None = None) -> tuple[LiveTurn, ...]:
        with self._lock:
            return tuple(
                turn
                for turn in self._turns.values()
                if agent_id is None or turn.agent_id == agent_id
            )

    def begin(self, run: AgentRun) -> BoundLiveTurn:
        with self._lock:
            if self._closed:
                raise RuntimeError("Live snapshots are closed")
            current = self._turns.get(run.agent_id)
            if current is not None and (
                current.status == "running" or current.sequence >= run.sequence
            ):
                raise RuntimeError("A current Turn still covers this Agent")
            self._turns[run.agent_id] = LiveTurn(
                self.runtime_epoch,
                run.agent_id,
                run.sequence,
                run.run_id,
                run.started_at,
            )
        return BoundLiveTurn(self, run.agent_id, run.sequence)

    def _update(
        self,
        agent_id: int,
        sequence: int,
        transform: Callable[[LiveTurn], LiveTurn],
        event: str | None,
        handle: ModelRequestHandle | None = None,
        part_index: int | None = None,
        saved: bool = False,
    ) -> None:
        with self._lock:
            if self._closed:
                return
            current = self._turns.get(agent_id)
            if current is None or current.sequence != sequence:
                return
            changed = transform(current)
            if changed == current:
                return
            updated = replace(changed, live_revision=current.live_revision + 1)
            self._turns[agent_id] = updated
        payload: dict[str, object] = {
            "runtime_epoch": self.runtime_epoch,
            "agent_id": agent_id,
            "sequence": sequence,
            "live_revision": updated.live_revision,
        }
        if saved:
            payload["saved"] = True
        if handle is not None:
            payload.update(request_id=handle.request_id, ordinal=handle.ordinal)
        if part_index is not None:
            payload["part_index"] = part_index
        if event is not None:
            self._emit(event, payload)

    def failed(self, agent_id: int, sequence: int, error: str) -> None:
        self._update(
            agent_id,
            sequence,
            lambda turn: replace(turn, status="unsaved", error=error),
            "tool.updated",
        )

    def finish(self, agent_id: int, sequence: int, error: str | None) -> None:
        current = next(iter(self.capture(agent_id)), None)
        if current is None or current.sequence != sequence:
            return
        if any(
            request.response_version is not None
            and not request.response_saved
            or any(not tool.saved for tool in request.tools)
            for request in current.requests
        ):
            self.failed(
                agent_id,
                sequence,
                error or current.error or "Content has not been saved",
            )
        else:
            self.remove(agent_id, sequence)

    def saved(
        self, agent_id: int, sequence: int, coverage: tuple[LiveRequestCoverage, ...]
    ) -> None:
        BoundLiveTurn(self, agent_id, sequence).saved(coverage)

    def remove(
        self, agent_id: int, sequence: int | None = None, *, saved: bool = True
    ) -> None:
        with self._lock:
            current = self._turns.get(agent_id)
            if current is None or (
                sequence is not None and current.sequence != sequence
            ):
                return
            del self._turns[agent_id]

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._turns.clear()


class BoundLiveTurn:
    def __init__(self, snapshots: LiveSnapshots, agent_id: int, sequence: int) -> None:
        self._snapshots = snapshots
        self._agent_id = agent_id
        self._sequence = sequence

    def _request(
        self,
        handle: ModelRequestHandle,
        transform: Callable[[LiveRequest], LiveRequest],
        event: str | None,
        part_index: int | None = None,
        saved: bool = False,
    ) -> None:
        def update(turn: LiveTurn) -> LiveTurn:
            if not any(
                request.request_id == handle.request_id
                and request.ordinal == handle.ordinal
                for request in turn.requests
            ):
                raise RuntimeError("Unknown live request identity")
            return replace(
                turn,
                requests=tuple(
                    transform(request)
                    if request.request_id == handle.request_id
                    and request.ordinal == handle.ordinal
                    else request
                    for request in turn.requests
                ),
            )

        self._snapshots._update(
            self._agent_id, self._sequence, update, event, handle, part_index, saved
        )

    def started(
        self, handle: ModelRequestHandle, started_at: str, model_json: str
    ) -> None:
        def update(turn: LiveTurn) -> LiveTurn:
            if any(
                request.ordinal == handle.ordinal
                or request.request_id == handle.request_id
                for request in turn.requests
            ):
                raise RuntimeError("Duplicate live request identity")
            return replace(
                turn,
                requests=(
                    *turn.requests,
                    LiveRequest(
                        handle.ordinal, handle.request_id, started_at, model_json
                    ),
                ),
            )

        self._snapshots._update(
            self._agent_id, self._sequence, update, "tool.updated", handle
        )

    def response(
        self,
        handle: ModelRequestHandle,
        tools: tuple[LiveTool, ...],
        response_json: str | None = None,
        response_version: str | None = None,
        completed_at: str | None = None,
    ) -> None:
        if len({tool.part_index for tool in tools}) != len(tools):
            raise RuntimeError("Duplicate live part identity")
        self._request(
            handle,
            lambda request: replace(
                request,
                tools=tools,
                response_json=response_json,
                response_version=response_version,
                response_saved=False,
                completed_at=completed_at,
            ),
            None,
        )

    def tool(self, handle: ModelRequestHandle, tool: LiveTool) -> None:
        def update(request: LiveRequest) -> LiveRequest:
            current = next(
                item for item in request.tools if item.part_index == tool.part_index
            )
            if (current.tool_call_id, current.tool_name) != (
                tool.tool_call_id,
                tool.tool_name,
            ):
                raise RuntimeError("Live tool identity changed")
            return replace(
                request,
                tools=tuple(
                    tool if item.part_index == tool.part_index else item
                    for item in request.tools
                ),
            )

        self._request(handle, update, "tool.updated", tool.part_index)

    def saved(self, coverage: tuple[LiveRequestCoverage, ...]) -> None:
        for item in coverage:

            def update(
                request: LiveRequest, item: LiveRequestCoverage = item
            ) -> LiveRequest:
                response_saved = request.response_saved or (
                    item.response_version is not None
                    and item.response_version == request.response_version
                )
                versions = dict(item.tools)
                return replace(
                    request,
                    response_saved=response_saved,
                    response_json=None if response_saved else request.response_json,
                    tools=tuple(
                        replace(tool, saved=True, result_json=None)
                        if tool.content_version is not None
                        and versions.get(tool.part_index) == tool.content_version
                        else tool
                        for tool in request.tools
                    ),
                )

            self._request(item.handle, update, "tool.updated", saved=True)
