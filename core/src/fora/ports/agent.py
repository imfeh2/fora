from __future__ import annotations

from collections.abc import Sequence
from contextlib import AbstractAsyncContextManager, AbstractContextManager
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

from fora.core.discussion import Message
from fora.ports.usage import UsageCache, UsageObservation


@dataclass(frozen=True)
class AgentRun:
    agent_id: int
    sequence: int
    run_id: str
    status: str
    started_at: str
    completed_at: str | None
    messages_json: str
    usage_json: str | None
    error: str | None
    window_number: int | None = None
    pending_revision: int = -1


@dataclass(frozen=True)
class RunSummary:
    sequence: int
    status: str
    started_at: str
    completed_at: str | None
    usage_json: str | None
    error: str | None


@dataclass(frozen=True)
class ModelRequestHandle:
    ordinal: int
    request_id: str


@dataclass(frozen=True)
class GenerationKey:
    agent_id: int
    sequence: int
    ordinal: int
    part_index: int
    request_id: str
    run_id: str


@dataclass(frozen=True)
class SendPreviewCandidate:
    discussion_id: int
    body: str


@dataclass(frozen=True)
class GenerationUpdate:
    part_kind: str
    content_json: str
    status: str = "generating"
    error: str | None = None
    preview: SendPreviewCandidate | None = None
    preview_error: str | None = None
    history_reference: str | None = None
    replace_part: bool = False


@dataclass(frozen=True)
class GenerationPart:
    key: GenerationKey
    part_kind: str
    revision: int
    status: str
    error: str | None
    created_at: str
    updated_at: str
    tool_name: str | None = None
    tool_call_id: str | None = None


@dataclass(frozen=True)
class DiscussionPreview:
    preview_id: str
    key: GenerationKey
    discussion_id: int | None
    revision: int
    status: str
    error: str | None
    message_id: int | None
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class GenerationMutation:
    part: GenerationPart
    preview: DiscussionPreview | None
    previous_discussion_id: int | None = None


@dataclass(frozen=True)
class GenerationTextPage:
    revision: int
    offset: int
    next_offset: int
    total_bytes: int
    value: str
    has_more: bool


@dataclass(frozen=True)
class WindowEvent:
    number: int
    since_sequence: int
    reset_at: str | None
    reason: str | None
    overflow_context: str | None = None


class HistoryWindowFilter(Enum):
    ALL = "all"


@dataclass(frozen=True)
class AgentHistoryWindow:
    number: int
    since_sequence: int | None
    started_at: str | None
    start_reason: str | None
    ended_at: str | None
    end_reason: str | None
    is_current: bool


@dataclass(frozen=True)
class AgentHistoryWindows:
    current_window_number: int
    windows: tuple[AgentHistoryWindow, ...]
    has_unassigned: bool


@dataclass(frozen=True)
class AgentHistoryRun:
    sequence: int
    run_id: str
    status: str
    started_at: str
    completed_at: str | None
    usage_json: str | None
    error: str | None
    window_number: int | None
    window_reset_at: str | None
    window_reason: str | None
    request_count: int
    last_saved_at: str | None
    reminded: tuple[tuple[int, int], ...] = ()


@dataclass(frozen=True)
class AgentModelRequestSummary:
    ordinal: int
    request_id: str
    run_id: str
    window_number: int | None
    status: str
    started_at: str
    completed_at: str | None
    streaming: bool
    input_length: int
    parameters_length: int
    settings_length: int
    model_length: int
    response_length: int
    input_count: int
    response_count: int
    related_count: int
    error: str | None


@dataclass(frozen=True)
class AgentModelRequest:
    summary: AgentModelRequestSummary
    parameters_json: str | None = None
    settings_json: str | None = None
    model_json: str | None = None


@dataclass(frozen=True)
class AgentTextPage:
    field: str
    offset: int
    total_bytes: int
    value: str
    has_more: bool


@dataclass(frozen=True)
class AgentMessagePage:
    channel: str
    offset: int
    total: int
    total_bytes: int
    messages: tuple[str, ...]
    has_more: bool


@dataclass(frozen=True)
class HistorySlice:
    sequence: int
    status: str
    started_at: str
    messages: str
    offset: int
    total_length: int
    last_saved_at: str | None = None


@dataclass(frozen=True)
class WindowState:
    number: int
    since_sequence: int
    reset_at: str | None
    reason: str | None
    overflow_context: str | None = None


@dataclass(frozen=True)
class TurnEffect:
    sequence: int
    ordinal: int
    tool: str
    summary: str
    created_at: str


@dataclass(frozen=True)
class AgentLifecycle:
    pause_requested: bool = False
    error: str | None = None
    prepared_sequence: int | None = None


class ModelRequestRecorder(Protocol):
    def generation_session(self) -> AbstractAsyncContextManager[None]: ...

    def generation_key(
        self, handle: ModelRequestHandle, part_index: int
    ) -> GenerationKey: ...

    def generation(
        self, handle: ModelRequestHandle, part_index: int, update: GenerationUpdate
    ) -> None: ...

    def start(
        self,
        messages_json: Sequence[str],
        parameters_json: str,
        settings_json: str,
        model_json: str,
        streaming: bool,
    ) -> ModelRequestHandle: ...

    def response(
        self, handle: ModelRequestHandle, response_json: Sequence[str]
    ) -> None: ...

    def related(
        self, handle: ModelRequestHandle, messages_json: Sequence[str]
    ) -> None: ...

    def error(self, handle: ModelRequestHandle, error: str) -> None: ...

    def success(self, handle: ModelRequestHandle) -> None: ...


class GenerationStore(Protocol):
    def save(
        self, key: GenerationKey, update: GenerationUpdate
    ) -> GenerationMutation: ...

    def part(self, key: GenerationKey) -> GenerationPart: ...

    def parts(
        self,
        agent_id: int,
        sequence: int,
        ordinal: int,
        *,
        after: int = -1,
        limit: int = 100,
    ) -> tuple[GenerationPart, ...]: ...

    def preview(self, key: GenerationKey) -> DiscussionPreview | None: ...

    def previews(
        self,
        discussion_id: int,
        member_id: int,
        *,
        before: tuple[str, str] | None = None,
        limit: int = 30,
        include_sent: bool = False,
    ) -> tuple[DiscussionPreview, ...]: ...

    def visible_preview(
        self, preview_id: str, discussion_id: int, member_id: int
    ) -> DiscussionPreview: ...

    def part_text(
        self,
        key: GenerationKey,
        revision: int,
        offset: int = 0,
        limit: int = 16384,
        *,
        field: str = "json",
    ) -> GenerationTextPage: ...

    def preview_text(
        self,
        preview_id: str,
        discussion_id: int,
        member_id: int,
        revision: int,
        offset: int = 0,
        limit: int = 16384,
    ) -> GenerationTextPage: ...

    def link(self, key: GenerationKey, message: Message) -> DiscussionPreview: ...

    def interrupt(
        self,
        *,
        agent_id: int | None = None,
        sequence: int | None = None,
        error: str = "Generation interrupted",
    ) -> int: ...


class HistoryStore(Protocol):
    def usage_query(self, params: dict[str, Any]) -> dict[str, Any]: ...

    def usage_advance(
        self, limit: int = 100, *, initialization_version: int | None = None
    ) -> dict[str, Any]: ...

    def usage_observe(
        self,
        params: dict[str, Any],
        observation: UsageObservation,
        cache: UsageCache | None = None,
    ) -> dict[str, Any]: ...

    def usage_display(
        self,
        observation: UsageObservation,
        *,
        agent_id: int | None = None,
        sequences: Sequence[int] = (),
        cache: UsageCache | None = None,
    ) -> dict[str, Any]: ...

    def usage_read(
        self, record_id: str, observation: UsageObservation | None = None
    ) -> dict[str, Any]: ...

    @property
    def generation(self) -> GenerationStore: ...

    def transaction(self) -> AbstractContextManager[object]: ...

    def pending_revision(self, agent_id: int) -> int: ...

    def repeated_turns(self, agent_id: int, keys: Sequence[tuple[int, int]]) -> int: ...

    def lifecycle(self, agent_id: int) -> AgentLifecycle: ...

    def set_lifecycle(self, agent_id: int, value: AgentLifecycle) -> None: ...

    def consume_preparation(
        self, agent_id: int, sequence: int, keys: Sequence[tuple[int, int]]
    ) -> None: ...

    def new_mentions(
        self, agent_id: int, keys: Sequence[tuple[int, int]]
    ) -> frozenset[tuple[int, int]]: ...

    def prepared_mentions(
        self, agent_id: int, sequence: int
    ) -> frozenset[tuple[int, int]]: ...

    def window(self, agent_id: int) -> WindowState: ...

    def reset_window(
        self, agent_id: int, reason: str, overflow_context: str | None = None
    ) -> WindowState: ...

    def window_events(
        self,
        agent_id: int,
        *,
        after: int | None = None,
        limit: int = 30,
        include_context: bool = True,
    ) -> tuple[WindowEvent, ...]: ...

    def start_run(
        self,
        agent_id: int,
        run_id: str | None = None,
        reminded: Sequence[tuple[int, int]] = (),
    ) -> AgentRun: ...

    def last_reminder(self, agent_id: int) -> frozenset[tuple[int, int]]: ...

    def no_tool_streak(self, agent_id: int) -> int: ...

    def preparation_incomplete(self, agent_id: int) -> bool: ...

    def preparation_failure_streak(self, agent_id: int, sequence: int) -> int: ...

    def pause_reason(self, agent_id: int) -> str | None: ...

    def pause_for_safety(self, agent_id: int, reason: str) -> None: ...

    def reset_safety(self, agent_id: int) -> None: ...

    def previously_reminded(
        self, agent_id: int, keys: Sequence[tuple[int, int]]
    ) -> frozenset[tuple[int, int]]: ...

    def save_progress(
        self, agent_id: int, sequence: int, messages_json: str
    ) -> None: ...

    def finish_run(
        self,
        agent_id: int,
        sequence: int,
        *,
        status: str,
        messages_json: str,
        usage_json: str | None = None,
        error: str | None = None,
    ) -> None: ...

    def start_model_request(
        self,
        agent_id: int,
        sequence: int,
        run_id: str,
        window_number: int,
        messages_json: Sequence[str],
        parameters_json: str,
        settings_json: str,
        model_json: str,
        streaming: bool,
    ) -> ModelRequestHandle: ...

    def finish_model_request(
        self,
        agent_id: int,
        sequence: int,
        handle: ModelRequestHandle,
        response_json: Sequence[str],
    ) -> None: ...

    def complete_model_request(
        self, agent_id: int, sequence: int, handle: ModelRequestHandle
    ) -> None: ...

    def link_model_request(
        self,
        agent_id: int,
        sequence: int,
        handle: ModelRequestHandle,
        messages_json: Sequence[str],
    ) -> None: ...

    def fail_model_request(
        self,
        agent_id: int,
        sequence: int,
        handle: ModelRequestHandle,
        error: str,
    ) -> None: ...

    def latest_messages(self, agent_id: int) -> str: ...

    def run_messages(self, agent_id: int, sequence: int) -> str | None: ...

    def history_run(self, agent_id: int, sequence: int) -> AgentHistoryRun | None: ...

    def history_windows(
        self,
        agent_id: int,
        *,
        before: int | None = None,
        limit: int = 30,
    ) -> AgentHistoryWindows: ...

    def history_runs(
        self,
        agent_id: int,
        *,
        before: int | None = None,
        limit: int = 30,
        window_number: int | None | HistoryWindowFilter = HistoryWindowFilter.ALL,
    ) -> tuple[AgentHistoryRun, ...]: ...

    def model_request_summaries(
        self,
        agent_id: int,
        sequence: int,
        *,
        after: int | None = None,
        limit: int = 30,
    ) -> tuple[AgentModelRequestSummary, ...]: ...

    def model_request_summary(
        self, agent_id: int, sequence: int, ordinal: int
    ) -> AgentModelRequestSummary | None: ...

    def model_request(
        self, agent_id: int, sequence: int, ordinal: int
    ) -> AgentModelRequest | None: ...

    def model_request_field(
        self,
        agent_id: int,
        sequence: int,
        ordinal: int,
        field: str,
        offset: int,
        limit: int,
    ) -> AgentTextPage: ...

    def model_request_messages(
        self,
        agent_id: int,
        sequence: int,
        ordinal: int,
        channel: str,
        offset: int,
        limit: int,
    ) -> AgentMessagePage: ...

    def model_request_message(
        self,
        agent_id: int,
        sequence: int,
        ordinal: int,
        channel: str,
        position: int,
    ) -> str | None: ...

    def runs(self, agent_id: int, *, limit: int = 50) -> tuple[AgentRun, ...]: ...

    def run_summaries(
        self, agent_id: int, *, limit: int = 50
    ) -> tuple[RunSummary, ...]: ...

    def record_effect(
        self, agent_id: int, sequence: int, tool: str, summary: str
    ) -> None: ...

    def effects(
        self, agent_id: int, *, sequences: Sequence[int] = ()
    ) -> tuple[TurnEffect, ...]: ...

    def usage_total(self, agent_id: int) -> dict[str, int]: ...

    def mark_interrupted(self) -> int: ...

    def mark_session_start(self) -> int: ...

    def search_runs(
        self, agent_id: int, query: str, *, limit: int = 20
    ) -> tuple[AgentRun, ...]: ...

    def read_run_slice(
        self, agent_id: int, sequence: int, offset: int | None, limit: int
    ) -> HistorySlice | None: ...


class SettingsStore(Protocol):
    def get_settings(self, section: str) -> dict[str, object] | None: ...

    def set_settings(self, section: str, values: dict[str, object]) -> None: ...

    def update_settings(
        self,
        section: str,
        values: dict[str, object],
    ) -> dict[str, object]: ...

    def create_agent_with_model(
        self,
        name: str,
        model_config: object | None,
    ) -> dict[str, object]: ...

    def delete_agent_with_model(self, agent_id: int) -> None: ...

    def model_catalog(self) -> dict[str, object]: ...

    def agent_model_selection(self, agent_id: int) -> dict[str, object]: ...
