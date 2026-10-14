from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

from fora.ports.agent import ModelRequestHandle

ToolStatus = Literal["queued", "running", "completed", "failed", "cancelled"]


@dataclass(frozen=True)
class LiveTool:
    part_index: int
    tool_call_id: str
    tool_name: str
    status: ToolStatus = "queued"
    started_at: str | None = None
    completed_at: str | None = None
    result_json: str | None = None
    saved: bool = False
    content_version: str | None = None


@dataclass(frozen=True)
class LiveRequest:
    ordinal: int
    request_id: str
    started_at: str
    model_json: str
    usage_json: str | None = None
    tools: tuple[LiveTool, ...] = ()
    response_json: str | None = None
    response_version: str | None = None
    response_saved: bool = False
    usage_metadata_json: str = "{}"
    completed_at: str | None = None


@dataclass(frozen=True)
class LiveTurn:
    runtime_epoch: str
    agent_id: int
    sequence: int
    run_id: str
    started_at: str
    live_revision: int = 0
    requests: tuple[LiveRequest, ...] = ()
    status: str = "running"
    error: str | None = None


@dataclass(frozen=True)
class LiveRequestCoverage:
    handle: ModelRequestHandle
    response_version: str | None = None
    tools: tuple[tuple[int, str], ...] = ()


class LiveTurnObserver(Protocol):
    def started(
        self, handle: ModelRequestHandle, started_at: str, model_json: str
    ) -> None: ...

    def response(
        self,
        handle: ModelRequestHandle,
        usage_json: str,
        tools: tuple[LiveTool, ...],
        response_json: str | None = None,
        response_version: str | None = None,
        usage_metadata_json: str = "{}",
        completed_at: str | None = None,
    ) -> None: ...

    def tool(self, handle: ModelRequestHandle, tool: LiveTool) -> None: ...

    def saved(self, coverage: tuple[LiveRequestCoverage, ...]) -> None: ...
