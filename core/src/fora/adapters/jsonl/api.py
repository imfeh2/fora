from __future__ import annotations

import base64
from collections.abc import Callable
from contextlib import AbstractContextManager, nullcontext
from dataclasses import asdict
from functools import partial
from typing import Any, NamedTuple

from fora.adapters.files.tree import relative_path
from fora.adapters.jsonl.protocol import Dispatcher, RequestScope, Resource
from fora.adapters.model.config import ModelCatalog
from fora.adapters.model.history import (
    binary_from_history,
    render_history,
    text_from_history,
)
from fora.adapters.model.runner import live_coverage
from fora.adapters.voice.config import VoiceConfig
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.core.parameters import agent_parameters
from fora.ports.agent import GenerationKey, HistoryWindowFilter, SettingsStore
from fora.ports.usage import UsageCache
from fora.runtime.scheduler import Scheduler
from fora.runtime_info import RuntimeInfo
from fora.tools import AgentTools
from fora.tools.authorize import Actor

HUMAN_ID = 1


def _render_live_page(
    raw: str,
    ordinal: int,
    part_index: int,
    epoch: str,
    content_source: str,
    content_version: str | None,
    *,
    offset: int = 0,
    limit: int = 100,
) -> dict[str, Any]:
    rendered = render_history(
        raw, source="live", request_ordinal=ordinal, offset=offset, limit=limit
    )

    def identity(value: Any) -> None:
        if isinstance(value, dict):
            if value.get("kind") in ("text", "binary"):
                value.update(
                    part_index=part_index,
                    runtime_epoch=epoch,
                    content_source=content_source,
                    content_version=content_version,
                    saved=False,
                )
            for child in value.values():
                identity(child)
        elif isinstance(value, list):
            for child in value:
                identity(child)

    identity(rendered)
    rendered["saved"] = False
    return rendered


ModelProbe = Callable[[dict[str, Any], dict[str, Any] | None], dict[str, Any]]


def _integer_param(
    params: dict[str, Any],
    name: str,
    *,
    default: int | None = None,
    maximum: int | None = None,
) -> int | None:
    value = params.get(name, default)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise DomainError(
            ErrorCode.INVALID_PARAMS, f"{name} must be a non-negative integer"
        )
    if maximum is not None and value > maximum:
        raise DomainError(ErrorCode.INVALID_PARAMS, f"{name} exceeds its maximum")
    return value


def _required_integer(params: dict[str, Any], name: str) -> int:
    value = _integer_param(params, name)
    if value is None:
        raise DomainError(ErrorCode.INVALID_PARAMS, f"{name} is required")
    return value


def _usage_version(result: dict[str, Any]) -> dict[str, Any]:
    return {
        key: result[key]
        for key in ("dataset_revision", "runtime_epoch", "live_versions", "index")
    }


def _required_string(params: dict[str, Any], name: str) -> str:
    value = params.get(name)
    if not isinstance(value, str) or not value or len(value) > 256:
        raise DomainError(
            ErrorCode.INVALID_PARAMS, f"{name} must be a non-empty string"
        )
    return value


def _generation_bounds(params: dict[str, Any]) -> tuple[int, int, int]:
    revision = _required_integer(params, "revision")
    offset = _integer_param(params, "offset", default=0, maximum=2**63 - 1)
    limit = _integer_param(params, "limit", default=16384, maximum=65536)
    assert offset is not None and limit is not None
    if revision == 0 or limit == 0:
        raise DomainError(
            ErrorCode.INVALID_PARAMS, "revision and limit must be positive"
        )
    return revision, offset, limit


def _history_run_payload(run: Any) -> dict[str, Any]:
    return {
        "sequence": run.sequence,
        "run_id": run.run_id,
        "status": run.status,
        "started_at": run.started_at,
        "completed_at": run.completed_at,
        "usage": run.usage_json,
        "error": run.error,
        "window_number": run.window_number,
        "window_reset_at": run.window_reset_at,
        "window_reason": run.window_reason,
        "request_count": run.request_count,
        "last_saved_at": run.last_saved_at,
        "legacy": run.request_count == 0,
        "reminded": [
            {"discussion_id": discussion_id, "message_id": message_id}
            for discussion_id, message_id in run.reminded
        ],
    }


def _window_event_payload(event: Any) -> dict[str, Any]:
    return {
        "number": event.number,
        "since_sequence": event.since_sequence,
        "reset_at": event.reset_at,
        "reason": event.reason,
    }


def _request_summary_payload(summary: Any) -> dict[str, Any]:
    return {
        "ordinal": summary.ordinal,
        "request_id": summary.request_id,
        "run_id": summary.run_id,
        "window_number": summary.window_number,
        "status": summary.status,
        "started_at": summary.started_at,
        "completed_at": summary.completed_at,
        "streaming": summary.streaming,
        "input_length": summary.input_length,
        "parameters_length": summary.parameters_length,
        "settings_length": summary.settings_length,
        "model_length": summary.model_length,
        "response_length": summary.response_length,
        "input_count": summary.input_count,
        "response_count": summary.response_count,
        "related_count": summary.related_count,
        "error": summary.error,
    }


def _render_message_page(
    page: Any, source: str, request_ordinal: int
) -> dict[str, Any]:
    messages = [
        render_history(
            raw,
            source=source,
            request_ordinal=request_ordinal,
            limit=1,
            message_index_base=page.offset + index,
        )["messages"][0]
        for index, raw in enumerate(page.messages)
    ]
    return {
        "messages": messages,
        "offset": page.offset,
        "total": page.total,
        "total_bytes": page.total_bytes,
        "has_more": page.has_more,
    }


def _render_model_field_page(
    page: Any, source: str, request_ordinal: int
) -> dict[str, Any]:
    value_bytes = len(page.value.encode("utf-8"))
    return {
        "kind": "text",
        "source": source,
        "request_ordinal": request_ordinal,
        "message_index": 0,
        "path": [],
        "offset": page.offset,
        "next_offset": page.offset + value_bytes,
        "total_bytes": page.total_bytes,
        "value": page.value,
        "has_more": page.has_more,
    }


def _list_models(values: dict[str, Any], stored: dict[str, Any] | None) -> Any:
    from fora.adapters.model.probe import list_models

    return list_models(values, stored)


def _test_model(values: dict[str, Any], stored: dict[str, Any] | None) -> Any:
    from fora.adapters.model.probe import try_model

    return try_model(values, stored)


class Api:
    def __init__(
        self,
        scheduler: Scheduler,
        dispatcher: Dispatcher,
        *,
        list_models: ModelProbe = _list_models,
        test_model: ModelProbe = _test_model,
        runtime_info: RuntimeInfo | None = None,
        reading: Callable[[], AbstractContextManager[None]] = nullcontext,
    ) -> None:
        self._scheduler = scheduler
        self._dispatcher = dispatcher
        self._list_models = list_models
        self._test_model = test_model
        self._runtime_info = runtime_info or RuntimeInfo.capture()
        self._reading = reading
        self._register()

    def _human(self) -> AgentTools:
        return self._scheduler.tools_for_actor(Actor(HUMAN_ID, False))

    def _changed(self, event: str, payload: dict[str, Any]) -> None:
        self._dispatcher.emit(event, payload)
        self._scheduler.wake()

    def _register(self) -> None:
        register = self._dispatcher.register
        context = _Context(
            api=self,
            settings=self._scheduler.settings,
            member_set=Resource("member"),
            discussion_set=Resource("discussion"),
            model_settings=Resource("settings", "model"),
            attachments=Resource("attachments", HUMAN_ID),
        )

        register(
            "upload.create",
            partial(upload_create, context),
            scope=lambda params: RequestScope(
                writes=(discussion_resource(context, params), context.attachments)
            ),
        )

        register(
            "upload.status",
            lambda params: self._human().upload_status(params["upload_ids"]),
            scope=lambda params: RequestScope(writes=(context.attachments,)),
        )

        register(
            "upload.cancel",
            lambda params: self._human().cancel_uploads(params["upload_ids"]),
            scope=lambda params: RequestScope(writes=(context.attachments,)),
        )

        register(
            "discussion.send_status",
            lambda params: self._human().send_status(
                params["discussion_id"], params["client_message_id"]
            ),
            scope=partial(discussion_query, context),
        )

        register(
            "discussion.cancel_send",
            lambda params: self._human().cancel_send(
                params["discussion_id"], params["client_message_id"]
            ),
            scope=partial(discussion_change, context),
        )

        register(
            "info.get", partial(info_get, context), scope=partial(independent, context)
        )

        register(
            "organization.get",
            partial(organization_get, context),
            scope=lambda params: RequestScope(
                reads=(
                    context.member_set,
                    context.model_settings,
                    Resource("history"),
                    Resource("settings", "agent"),
                    Resource("settings", "execution"),
                )
            ),
        )

        register(
            "organization.create_agent",
            partial(create_agent, context),
            scope=lambda params: RequestScope(
                writes=(context.member_set, context.model_settings)
            ),
        )

        register(
            "organization.set_model",
            partial(organization_set_model, context),
            scope=lambda params: RequestScope(
                writes=(context.member_set, context.model_settings)
            ),
        )

        register(
            "organization.rename_member",
            partial(rename_member, context),
            scope=lambda params: RequestScope(
                reads=(context.member_set,),
                writes=(Resource("member", int(params["member_id"])),),
            ),
        )

        register(
            "organization.pause_agent",
            partial(pause_agent, context),
            scope=partial(agent_change, context),
        )

        register(
            "organization.resume_agent",
            partial(resume_agent, context),
            scope=partial(agent_change, context),
        )

        register(
            "organization.delete_agent",
            partial(delete_agent, context),
            scope=lambda params: RequestScope(
                writes=(
                    Resource("member", int(params["agent_id"])),
                    context.discussion_set,
                    context.model_settings,
                )
            ),
        )

        register(
            "discussion.create",
            partial(discussion_create, context),
            scope=lambda params: RequestScope(
                reads=(context.member_set,), writes=(context.discussion_set,)
            ),
        )

        register(
            "discussion.list",
            partial(discussion_list, context),
            scope=lambda params: RequestScope(
                reads=(context.discussion_set, context.member_set)
            ),
        )

        register(
            "discussion.read",
            partial(discussion_read, context),
            scope=partial(discussion_change, context),
        )

        register(
            "discussion.page",
            partial(discussion_page, context),
            scope=partial(discussion_query, context),
        )

        register(
            "discussion.previews",
            partial(discussion_previews, context),
            scope=partial(discussion_query, context),
        )

        register(
            "discussion.preview",
            partial(discussion_preview, context),
            scope=partial(discussion_query, context),
        )

        register(
            "discussion.preview.text",
            partial(discussion_preview_text, context),
            scope=partial(discussion_query, context),
        )

        register(
            "discussion.mark_read",
            partial(discussion_mark_read, context),
            scope=partial(discussion_change, context),
        )

        register(
            "discussion.send",
            partial(discussion_send, context),
            scope=partial(discussion_send_scope, context),
        )

        register(
            "discussion.set_members",
            partial(discussion_members, context),
            scope=partial(discussion_change, context),
        )

        register(
            "discussion.add_members",
            partial(discussion_add_members, context),
            scope=partial(discussion_change, context),
        )

        register(
            "discussion.remove_members",
            partial(discussion_remove_members, context),
            scope=partial(discussion_change, context),
        )

        register(
            "discussion.archive",
            partial(discussion_archive, context),
            scope=partial(discussion_change, context),
        )

        register(
            "discussion.unarchive",
            partial(discussion_unarchive, context),
            scope=partial(discussion_change, context),
        )

        register(
            "discussion.search",
            partial(discussion_search, context),
            scope=lambda params: RequestScope(
                reads=(
                    Resource(
                        "discussion",
                        int(params["discussion_id"])
                        if params.get("discussion_id") is not None
                        else None,
                    ),
                    context.member_set,
                )
            ),
        )

        register(
            "library.list",
            partial(library_list, context),
            scope=lambda params: library_scope(context, params, directory=True),
        )

        register(
            "library.read",
            partial(library_read, context),
            scope=partial(library_scope, context),
        )

        register(
            "library.write",
            partial(library_write, context),
            scope=lambda params: library_scope(context, params, writing=True),
        )

        register(
            "library.edit",
            partial(library_edit, context),
            scope=lambda params: library_scope(context, params, writing=True),
        )

        register(
            "library.mkdir",
            partial(library_mkdir, context),
            scope=lambda params: library_scope(
                context, params, writing=True, directory=True
            ),
        )

        register(
            "workspace.list",
            partial(workspace_list, context),
            scope=partial(workspace_scope, context),
        )

        register(
            "workspace.read",
            partial(workspace_read, context),
            scope=partial(workspace_scope, context),
        )

        register(
            "library.delete",
            partial(library_delete, context),
            scope=lambda params: library_scope(
                context, params, writing=True, directory=True
            ),
        )

        register(
            "library.move",
            partial(library_move, context),
            scope=lambda params: library_scope(
                context, params, writing=True, directory=True, moving=True
            ),
        )

        register(
            "usage.query",
            partial(usage_query, context),
            scope=lambda params: RequestScope(
                reads=(context.member_set, Resource("history"))
            ),
        )

        register(
            "usage.read",
            partial(usage_read, context),
            scope=lambda params: RequestScope(
                reads=(context.member_set, Resource("history"))
            ),
        )

        register(
            "usage.advance",
            partial(usage_advance, context),
            scope=lambda params: RequestScope(
                reads=(context.member_set,), writes=(Resource("history"),)
            ),
        )

        register(
            "agent.live",
            partial(agent_live, context),
            scope=partial(agent_query, context),
        )

        register(
            "agent.live.read",
            partial(agent_live_read, context),
            scope=partial(agent_query, context),
        )

        register(
            "agent.history",
            partial(agent_history, context),
            scope=partial(agent_query, context),
        )

        register(
            "agent.history.windows",
            partial(agent_history_windows, context),
            scope=partial(agent_query, context),
        )

        register(
            "agent.history.read",
            partial(agent_history_read, context),
            scope=partial(agent_query, context),
        )

        register(
            "agent.history.window",
            partial(agent_history_window, context),
            scope=partial(agent_query, context),
        )

        register(
            "agent.history.window_requests",
            partial(agent_history_window_requests, context),
            scope=partial(agent_query, context),
        )

        register(
            "agent.history.window_request",
            partial(agent_history_window_request, context),
            scope=partial(agent_query, context),
        )

        register(
            "agent.history.input_sources",
            partial(agent_history_input_sources, context),
            scope=partial(agent_query, context),
        )

        register(
            "agent.history.text",
            partial(agent_history_text, context),
            scope=partial(agent_query, context),
        )

        register(
            "agent.history.image",
            partial(agent_history_image, context),
            scope=partial(agent_query, context),
        )

        register(
            "agent.generation.parts",
            partial(agent_generation_parts, context),
            scope=partial(agent_query, context),
        )

        register(
            "agent.generation.text",
            partial(agent_generation_text, context),
            scope=partial(agent_query, context),
        )

        register(
            "settings.get",
            partial(settings_get, context),
            scope=partial(setting_query, context),
        )

        register(
            "settings.update",
            partial(settings_update, context),
            scope=partial(setting_change, context),
        )

        register(
            "settings.list_models",
            partial(settings_list_models, context),
            scope=lambda params: RequestScope(reads=(context.model_settings,)),
        )

        register(
            "settings.test_model",
            partial(settings_test_model, context),
            scope=lambda params: RequestScope(reads=(context.model_settings,)),
        )


class _Context(NamedTuple):
    api: Api
    settings: SettingsStore
    member_set: Resource
    discussion_set: Resource
    model_settings: Resource
    attachments: Resource


def info_get(context: _Context, params: dict[str, Any]) -> Any:
    del params
    return context.api._runtime_info.as_dict()


def organization_get(context: _Context, params: dict[str, Any]) -> Any:
    del params
    observation = context.api._scheduler.live.usage_capture()
    with context.api._reading():
        members = context.api._human().list_member_records()
        usage_data = context.api._scheduler.history.usage_display(
            observation, cache=UsageCache.current("organization")
        )
        grouped = {
            group["agent_id"]: group for group in usage_data["groups"]["agent_id"]
        }
        for member in members:
            if member["type"] == "agent":
                metrics = grouped.get(int(member["id"]))
                member["usage_metrics"] = metrics
                member["usage_index_ready"] = bool(usage_data["index"]["ready"])
                member["tokens"] = (
                    int(metrics["total_tokens"])
                    if metrics is not None and metrics["total_tokens"] is not None
                    else None
                    if metrics is not None
                    else 0
                )
        organization_uuid = context.api._human().organization_uuid()
        statistics = context.api._scheduler.statistics()
    for member in members:
        if member["type"] == "agent":
            member.update(context.api._scheduler.agent_status(int(member["id"])))
    return {
        "id": 1,
        "uuid": organization_uuid,
        "members": members,
        "human_id": HUMAN_ID,
        "usage_version": _usage_version(usage_data),
        **statistics,
    }


def create_agent(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().create_agent(
        str(params.get("name", "")), params.get("model_config")
    )


def organization_set_model(context: _Context, params: dict[str, Any]) -> Any:
    agent_id = _required_integer(params, "agent_id")
    result = context.api._human().set_agent_model(agent_id, params.get("model_config"))
    context.api._dispatcher.emit("settings.updated", {"section": "model"})
    return result


def rename_member(context: _Context, params: dict[str, Any]) -> Any:
    result = context.api._human().rename_member(
        int(params["member_id"]), str(params.get("name", ""))
    )
    context.api._changed("member.updated", result)
    return result


def pause_agent(context: _Context, params: dict[str, Any]) -> Any:
    result = context.api._human().pause_agent(int(params["agent_id"]))
    context.api._changed("member.updated", result)
    return result


def resume_agent(context: _Context, params: dict[str, Any]) -> Any:
    result = context.api._human().resume_agent(int(params["agent_id"]))
    context.api._changed("member.updated", result)
    return result


def delete_agent(context: _Context, params: dict[str, Any]) -> Any:
    result = context.api._human().delete_agent(int(params["agent_id"]))
    context.api._changed("member.deleted", result)
    return result


def discussion_create(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().create_discussion(
        str(params.get("topic", "")), list(params.get("member_ids", []))
    )


def discussion_list(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().list_discussions(
        bool(params.get("include_archived", False)), limit=params.get("limit")
    )


def discussion_read(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().read_discussion(
        params["discussion_id"],
        params.get("message_id"),
        params.get("limit"),
        before=params.get("before"),
        after=params.get("after"),
        max_chars=params.get("max_chars"),
        section=params.get("section", "messages"),
        cursor=params.get("cursor"),
    )


def discussion_page(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().discussion_page(
        params["discussion_id"],
        limit=params.get("limit", 50),
        entry=params.get("entry", False),
        before=params.get("before"),
        after=params.get("after"),
        metadata=params.get("metadata", False),
    )


def discussion_previews(context: _Context, params: dict[str, Any]) -> Any:
    discussion_id = _required_integer(params, "discussion_id")
    limit = _integer_param(params, "limit", default=30, maximum=50)
    assert limit is not None
    if limit == 0:
        raise DomainError(ErrorCode.INVALID_PARAMS, "limit must be positive")
    before = params.get("before")
    if before is not None and (
        not isinstance(before, list)
        or len(before) != 2
        or any(not isinstance(item, str) or not item for item in before)
    ):
        raise DomainError(ErrorCode.INVALID_PARAMS, "before must be a sort key")
    with context.api._reading():
        page = context.api._scheduler.history.generation.previews(
            discussion_id,
            HUMAN_ID,
            before=(before[0], before[1]) if before is not None else None,
            limit=limit + 1,
            include_sent=True,
        )
    previews = page[:limit]
    has_more = len(page) > limit
    return {
        "discussion_id": discussion_id,
        "previews": [asdict(item) for item in previews],
        "has_more": has_more,
        "next_before": [previews[-1].created_at, previews[-1].preview_id]
        if previews and has_more
        else None,
    }


def discussion_preview(context: _Context, params: dict[str, Any]) -> Any:
    discussion_id = _required_integer(params, "discussion_id")
    preview_id = _required_string(params, "preview_id")
    with context.api._reading():
        preview = context.api._scheduler.history.generation.visible_preview(
            preview_id, discussion_id, HUMAN_ID
        )
        body = context.api._scheduler.history.generation.preview_text(
            preview_id, discussion_id, HUMAN_ID, preview.revision
        )
    return {"preview": asdict(preview), "body": asdict(body)}


def discussion_preview_text(context: _Context, params: dict[str, Any]) -> Any:
    discussion_id = _required_integer(params, "discussion_id")
    preview_id = _required_string(params, "preview_id")
    revision, offset, limit = _generation_bounds(params)
    with context.api._reading():
        page = context.api._scheduler.history.generation.preview_text(
            preview_id, discussion_id, HUMAN_ID, revision, offset, limit
        )
    return asdict(page)


def agent_generation_parts(context: _Context, params: dict[str, Any]) -> Any:
    agent_id = _required_integer(params, "agent_id")
    sequence = _required_integer(params, "sequence")
    ordinal = _required_integer(params, "ordinal")
    after = _integer_param(params, "after", maximum=2**63 - 1)
    limit = _integer_param(params, "limit", default=30, maximum=50)
    assert limit is not None
    if limit == 0:
        raise DomainError(ErrorCode.INVALID_PARAMS, "limit must be positive")
    with context.api._reading():
        context.api._human().authorize_agent_history(agent_id)
        page = context.api._scheduler.history.generation.parts(
            agent_id,
            sequence,
            ordinal,
            after=after if after is not None else -1,
            limit=limit + 1,
        )
    parts = page[:limit]
    has_more = len(page) > limit
    return {
        "agent_id": agent_id,
        "sequence": sequence,
        "ordinal": ordinal,
        "parts": [asdict(item) for item in parts],
        "has_more": has_more,
        "next_after": parts[-1].key.part_index if parts and has_more else None,
    }


def agent_generation_text(context: _Context, params: dict[str, Any]) -> Any:
    agent_id = _required_integer(params, "agent_id")
    sequence = _required_integer(params, "sequence")
    ordinal = _required_integer(params, "ordinal")
    part_index = _required_integer(params, "part_index")
    request_id = _required_string(params, "request_id")
    field = params.get("field", "json")
    revision, offset, limit = _generation_bounds(params)
    with context.api._reading():
        context.api._human().authorize_agent_history(agent_id)
        summary = context.api._scheduler.history.model_request_summary(
            agent_id, sequence, ordinal
        )
        if summary is None:
            raise DomainError(ErrorCode.NOT_FOUND, "Model request does not exist")
        key = GenerationKey(
            agent_id,
            sequence,
            ordinal,
            part_index,
            request_id,
            summary.run_id,
        )
        page = context.api._scheduler.history.generation.part_text(
            key, revision, offset, limit, field=field
        )
    return {"key": asdict(key), "field": field, **asdict(page)}


def discussion_mark_read(context: _Context, params: dict[str, Any]) -> Any:
    result = context.api._human().mark_read(
        params["discussion_id"], params["message_id"]
    )
    context.api._dispatcher.emit("discussion.read_updated", result)
    return result


def discussion_send(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().send_message(
        int(params["discussion_id"]),
        str(params.get("body", "")),
        mark_read=params.get("mark_read", True),
        attachment_ids=params.get("attachment_ids", []),
        client_message_id=params.get("client_message_id"),
    )


def upload_create(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().create_upload(
        params["discussion_id"],
        params["client_upload_id"],
        params["name"],
        params["size"],
        params.get("media_type", ""),
    )


def independent(context: _Context, params: dict[str, Any]) -> RequestScope:
    return RequestScope()


def discussion_resource(context: _Context, params: dict[str, Any]) -> Resource:
    return Resource("discussion", int(params["discussion_id"]))


def discussion_query(context: _Context, params: dict[str, Any]) -> RequestScope:
    return RequestScope(
        reads=(discussion_resource(context, params), context.member_set)
    )


def discussion_change(context: _Context, params: dict[str, Any]) -> RequestScope:
    return RequestScope(
        reads=(context.member_set,), writes=(discussion_resource(context, params),)
    )


def discussion_send_scope(context: _Context, params: dict[str, Any]) -> RequestScope:
    scope = discussion_change(context, params)
    if params.get("attachment_ids"):
        return RequestScope(
            scope.reads + (context.attachments,), scope.writes + (context.attachments,)
        )
    return scope


def agent_query(context: _Context, params: dict[str, Any]) -> RequestScope:
    identity = _required_integer(params, "agent_id")
    return RequestScope(
        reads=(Resource("member", identity), Resource("history", identity))
    )


def agent_change(context: _Context, params: dict[str, Any]) -> RequestScope:
    return RequestScope(writes=(Resource("member", int(params["agent_id"])),))


def workspace_scope(context: _Context, params: dict[str, Any]) -> RequestScope:
    identity = int(params["agent_id"])
    return RequestScope(
        reads=(Resource("member", identity),),
        writes=(Resource("workspace", identity),),
    )


def setting_query(context: _Context, params: dict[str, Any]) -> RequestScope:
    section = str(params.get("section", "model"))
    resource = Resource("settings", section)
    return (
        RequestScope(writes=(resource,))
        if section == "voice"
        else RequestScope(reads=(resource,))
    )


def setting_change(context: _Context, params: dict[str, Any]) -> RequestScope:
    section = str(params.get("section", "model"))
    return RequestScope(
        reads=(context.member_set,) if section == "model" else (),
        writes=(Resource("settings", section),),
    )


def library_scope(
    context: _Context,
    params: dict[str, Any],
    *,
    writing: bool = False,
    directory: bool = False,
    moving: bool = False,
) -> RequestScope:
    path = params.get("path") if directory and not writing else str(params["path"])
    root = context.api._human().library_root

    def identities(value: str, descendants: bool) -> tuple[Resource, ...]:
        target = root / relative_path(value, allow_root=descendants)
        resolved = target.resolve()
        if not resolved.is_relative_to(root):
            raise DomainError(ErrorCode.INVALID_PATH, "Path must stay inside the tree")
        return tuple(
            dict.fromkeys(
                (
                    Resource("library", target, descendants),
                    Resource("library", resolved, descendants),
                )
            )
        )

    resources = identities(path if path is not None else ".", directory)
    if moving:
        resources += identities(str(params["destination"]), True)
    return RequestScope(writes=resources) if writing else RequestScope(reads=resources)


def discussion_members(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().set_discussion_members(
        int(params["discussion_id"]), list(params.get("member_ids", []))
    )


def discussion_add_members(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().add_members(
        int(params["discussion_id"]), list(params["member_ids"])
    )


def discussion_remove_members(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().remove_members(
        int(params["discussion_id"]), list(params["member_ids"])
    )


def discussion_archive(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().archive_discussion(
        int(params["discussion_id"]), bool(params.get("archived", True))
    )


def discussion_unarchive(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().archive_discussion(int(params["discussion_id"]), False)


def discussion_search(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().search_messages(
        str(params.get("query", "")),
        sender_id=int(params["sender_id"])
        if params.get("sender_id") is not None
        else None,
        discussion_id=int(params["discussion_id"])
        if params.get("discussion_id") is not None
        else None,
    )


def library_list(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().list_library(params.get("path"))


def library_read(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().read_library(str(params["path"]))


def library_write(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().write_library(
        str(params["path"]),
        str(params.get("content", "")),
        params.get("expected_hash"),
    )


def library_edit(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().edit_library(
        str(params["path"]),
        str(params["old_text"]),
        str(params["new_text"]),
        bool(params.get("replace_all", False)),
    )


def library_mkdir(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().mkdir_library(str(params["path"]))


def workspace_list(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().list_workspace(
        params.get("path"), agent_id=int(params["agent_id"])
    )


def workspace_read(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().read_workspace(
        str(params["path"]), agent_id=int(params["agent_id"])
    )


def library_delete(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().delete_library(str(params["path"]))


def library_move(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._human().move_library(
        str(params["path"]), str(params["destination"])
    )


def agent_history_windows(context: _Context, params: dict[str, Any]) -> Any:
    agent_id = _required_integer(params, "agent_id")
    context.api._human().authorize_agent_history(agent_id)
    before = _integer_param(params, "before", maximum=2**63 - 1)
    limit = _integer_param(params, "limit", default=30, maximum=30)
    assert limit is not None
    if limit == 0:
        raise DomainError(ErrorCode.INVALID_PARAMS, "history limits must be positive")
    with context.api._reading():
        context.api._human().authorize_agent_history(agent_id)
        page = context.api._scheduler.history.history_windows(
            agent_id, before=before, limit=limit + 1
        )
    windows = page.windows[:limit]
    has_before = len(page.windows) > limit
    return {
        "agent_id": agent_id,
        "current_window_number": page.current_window_number,
        "windows": [asdict(window) for window in windows],
        "has_unassigned": page.has_unassigned,
        "has_before": has_before,
        "next_before": windows[-1].number if has_before else None,
    }


def agent_history_window(context: _Context, params: dict[str, Any]) -> Any:
    agent_id = _required_integer(params, "agent_id")
    window = _required_integer(params, "window")
    context.api._human().authorize_agent_history(agent_id)
    with context.api._reading():
        context.api._human().authorize_agent_history(agent_id)
        info = context.api._scheduler.history.window_by_number(agent_id, window)
        if info is None:
            raise DomainError(ErrorCode.UNKNOWN_WINDOW, "Window is not recorded")
        stats = context.api._scheduler.history.window_stats(agent_id, window)
    assert stats is not None
    return {
        "agent_id": agent_id,
        "window": asdict(info),
        "stats": asdict(stats),
    }


def agent_history_window_requests(context: _Context, params: dict[str, Any]) -> Any:
    agent_id = _required_integer(params, "agent_id")
    window = _required_integer(params, "window")
    limit = _integer_param(params, "limit", default=50, maximum=50)
    assert limit is not None
    if limit == 0:
        raise DomainError(ErrorCode.INVALID_PARAMS, "history limits must be positive")
    before_sequence = _integer_param(params, "before_sequence", maximum=2**63 - 1)
    before_ordinal = _integer_param(params, "before_ordinal", maximum=2**63 - 1)
    before = (
        (before_sequence, before_ordinal)
        if before_sequence is not None and before_ordinal is not None
        else None
    )
    with context.api._reading():
        context.api._human().authorize_agent_history(agent_id)
        if context.api._scheduler.history.window_by_number(agent_id, window) is None:
            raise DomainError(ErrorCode.UNKNOWN_WINDOW, "Window is not recorded")
        page = context.api._scheduler.history.window_requests(
            agent_id, window, before=before, limit=limit
        )
    return {
        "agent_id": agent_id,
        "window_number": page.window_number,
        "total": page.total,
        "start_index": page.start_index,
        "requests": [asdict(item) for item in page.requests],
        "has_more": page.has_more,
        "next_before": (
            {"sequence": page.next_before[0], "ordinal": page.next_before[1]}
            if page.next_before is not None
            else None
        ),
    }


def agent_history_window_request(context: _Context, params: dict[str, Any]) -> Any:
    agent_id = _required_integer(params, "agent_id")
    window = _required_integer(params, "window")
    sequence = _required_integer(params, "sequence")
    ordinal = _required_integer(params, "ordinal")
    with context.api._reading():
        context.api._human().authorize_agent_history(agent_id, include_deleted=True)
        if context.api._scheduler.history.window_by_number(agent_id, window) is None:
            raise DomainError(ErrorCode.UNKNOWN_WINDOW, "Window is not recorded")
        found = context.api._scheduler.history.window_request(
            agent_id, window, sequence, ordinal
        )
    if found is None:
        raise DomainError(
            ErrorCode.REQUEST_NOT_IN_WINDOW, "Request does not belong to the window"
        )
    return {
        "agent_id": agent_id,
        "window_number": window,
        "index": found.index,
        "total": found.total,
        "request": asdict(found.request.summary),
    }


def agent_history_input_sources(context: _Context, params: dict[str, Any]) -> Any:
    agent_id = _required_integer(params, "agent_id")
    sequence = _required_integer(params, "sequence")
    ordinal = _required_integer(params, "ordinal")
    with context.api._reading():
        context.api._human().authorize_agent_history(agent_id, include_deleted=True)
        sources = context.api._scheduler.history.input_sources(
            agent_id, sequence, ordinal
        )
    return {
        "agent_id": agent_id,
        "sequence": sequence,
        "ordinal": ordinal,
        "sources": [asdict(item) for item in sources],
        "has_instructions": any(item.kind == "instruction_parts" for item in sources),
    }


def agent_live(context: _Context, params: dict[str, Any]) -> Any:
    agent_id = _required_integer(params, "agent_id")
    captured = context.api._scheduler.live.capture(agent_id)
    with context.api._reading():
        context.api._human().authorize_agent_history(agent_id)
    sequence = _integer_param(params, "sequence")
    ordinal = _integer_param(params, "ordinal")
    after = _integer_param(params, "after")
    tool_after = _integer_param(params, "tool_after")
    limit = _integer_param(params, "limit", default=30, maximum=30)
    tool_limit = _integer_param(params, "tool_limit", default=100, maximum=100)
    if not limit or not tool_limit:
        raise DomainError(ErrorCode.INVALID_PARAMS, "Live limits must be positive")
    turn = next(
        (item for item in captured if sequence is None or item.sequence == sequence),
        None,
    )
    if turn is None:
        return {
            "runtime_epoch": context.api._scheduler.live.runtime_epoch,
            "turn": None,
        }
    candidates = tuple(
        request
        for request in turn.requests
        if (ordinal is None or request.ordinal == ordinal)
        and (after is None or request.ordinal > after)
    )
    selected = candidates[:limit]
    requests = []
    for request in selected:
        tools = tuple(
            tool
            for tool in request.tools
            if tool_after is None or tool.part_index > tool_after
        )
        requests.append(
            {
                "ordinal": request.ordinal,
                "request_id": request.request_id,
                "started_at": request.started_at,
                "response_saved": request.response_saved,
                "has_response": request.response_json is not None,
                "response_version": request.response_version,
                "tools": [
                    {
                        "part_index": tool.part_index,
                        "tool_call_id": tool.tool_call_id,
                        "tool_name": tool.tool_name,
                        "status": tool.status,
                        "started_at": tool.started_at,
                        "completed_at": tool.completed_at,
                        "saved": tool.saved,
                        "has_result": tool.result_json is not None,
                        "content_version": tool.content_version,
                    }
                    for tool in tools[:tool_limit]
                ],
                "tools_has_more": len(tools) > tool_limit,
                "tools_next_after": tools[tool_limit - 1].part_index
                if len(tools) > tool_limit
                else None,
            }
        )
    return {
        "runtime_epoch": turn.runtime_epoch,
        "turn": {
            "agent_id": turn.agent_id,
            "sequence": turn.sequence,
            "run_id": turn.run_id,
            "live_revision": turn.live_revision,
            "status": turn.status,
            "error": turn.error,
            "requests": requests,
            "has_more": len(candidates) > limit,
            "next_after": selected[-1].ordinal if len(candidates) > limit else None,
        },
    }


def live_result(
    context: _Context,
    params: dict[str, Any],
) -> tuple[str, int, int, str, str | None]:
    agent_id = _required_integer(params, "agent_id")
    sequence = _required_integer(params, "sequence")
    ordinal = _required_integer(params, "ordinal")
    part_index = _required_integer(params, "part_index")
    content_source = params.get("content_source", "tool")
    if content_source not in ("tool", "response"):
        raise DomainError(ErrorCode.INVALID_PARAMS, "Invalid live content source")
    captured = context.api._scheduler.live.capture(agent_id)
    with context.api._reading():
        context.api._human().authorize_agent_history(agent_id)
    epoch = params.get("runtime_epoch")
    version = params.get("content_version")
    if version is not None and not isinstance(version, str):
        raise DomainError(ErrorCode.INVALID_PARAMS, "Invalid live content version")
    if not isinstance(epoch, str) or epoch != context.api._scheduler.live.runtime_epoch:
        raise DomainError(
            ErrorCode.LIVE_CHANGED,
            "The runtime instance changed; refresh the Turn",
        )
    for turn in captured:
        if turn.sequence != sequence:
            continue
        for request in turn.requests:
            if request.ordinal != ordinal:
                continue
            if content_source == "response":
                if request.response_json is not None:
                    if version is not None and version != request.response_version:
                        raise DomainError(
                            ErrorCode.LIVE_CHANGED,
                            "The response content changed",
                        )
                    return (
                        request.response_json,
                        ordinal,
                        part_index,
                        epoch,
                        request.response_version,
                    )
                continue
            for tool in request.tools:
                if tool.part_index == part_index and tool.result_json is not None:
                    if version is not None and version != tool.content_version:
                        raise DomainError(
                            ErrorCode.LIVE_CHANGED, "The tool content changed"
                        )
                    return (
                        tool.result_json,
                        ordinal,
                        part_index,
                        epoch,
                        tool.content_version,
                    )
    raise DomainError(
        ErrorCode.LIVE_CHANGED, "The temporary result changed; refresh the Turn"
    )


def agent_live_read(context: _Context, params: dict[str, Any]) -> Any:
    raw, ordinal, part_index, epoch, version = live_result(context, params)
    return _render_live_page(
        raw,
        ordinal,
        part_index,
        epoch,
        params.get("content_source", "tool"),
        version,
    )


def agent_history(context: _Context, params: dict[str, Any]) -> Any:
    agent_id = _required_integer(params, "agent_id")
    context.api._human().authorize_agent_history(agent_id, include_deleted=True)
    limit = _integer_param(params, "limit", default=30, maximum=50)
    windows_after = _integer_param(params, "windows_after", maximum=2**63 - 1)
    windows_limit = _integer_param(params, "windows_limit", default=30, maximum=30)
    assert limit is not None
    assert windows_limit is not None
    if limit == 0 or windows_limit == 0:
        raise DomainError(ErrorCode.INVALID_PARAMS, "history limits must be positive")
    before = _integer_param(params, "before", maximum=2**63 - 1)
    window_number: int | None | HistoryWindowFilter = HistoryWindowFilter.ALL
    if "window_number" in params:
        window_number = _integer_param(params, "window_number", maximum=2**63 - 1)
        if window_number == 0:
            raise DomainError(
                ErrorCode.INVALID_PARAMS,
                "window_number must be a positive integer or null",
            )
    filtered = window_number is not HistoryWindowFilter.ALL
    observation = context.api._scheduler.live.usage_capture(agent_id)
    with context.api._reading():
        context.api._human().authorize_agent_history(agent_id)
        run_page = (
            context.api._scheduler.history.history_runs(
                agent_id,
                before=before,
                limit=limit + 1,
                window_number=window_number,
            )
            if filtered
            else context.api._scheduler.history.history_runs(
                agent_id, before=before, limit=limit
            )
        )
        runs = run_page[:limit]
        window_page = context.api._scheduler.history.window_events(
            agent_id,
            after=windows_after,
            limit=windows_limit + 1,
            include_context=False,
        )
        usage_data = context.api._scheduler.history.usage_display(
            observation,
            agent_id=agent_id,
            sequences=[run.sequence for run in runs],
            cache=UsageCache.current("history"),
        )
    windows = window_page[:windows_limit]
    has_more_windows = len(window_page) > windows_limit
    has_before = len(run_page) > limit if filtered else len(runs) == limit
    return {
        "agent_id": agent_id,
        **({"window_number": window_number} if filtered else {}),
        "runs": [
            {
                **_history_run_payload(run),
                "usage_metrics": usage_data["turns"].get(run.sequence),
            }
            for run in runs
        ],
        "usage_version": _usage_version(usage_data),
        "windows": [_window_event_payload(event) for event in windows],
        "has_before": has_before,
        "next_before": runs[-1].sequence if has_before else None,
        "windows_has_more": has_more_windows,
        "windows_next_after": (
            windows[-1].number if has_more_windows and windows else None
        ),
    }


def agent_history_read_data(context: _Context, params: dict[str, Any]) -> Any:
    agent_id = _required_integer(params, "agent_id")
    context.api._human().authorize_agent_history(agent_id, include_deleted=True)
    sequence = _required_integer(params, "sequence")
    message_offset = _integer_param(
        params, "message_offset", default=0, maximum=2**63 - 1
    )
    message_limit = _integer_param(params, "message_limit", default=100, maximum=100)
    input_offset = _integer_param(params, "input_offset", default=0, maximum=2**63 - 1)
    input_limit = _integer_param(params, "input_limit", default=100, maximum=100)
    response_offset = _integer_param(
        params, "response_offset", default=0, maximum=2**63 - 1
    )
    response_limit = _integer_param(params, "response_limit", default=100, maximum=100)
    related_offset = _integer_param(
        params, "related_offset", default=0, maximum=2**63 - 1
    )
    related_limit = _integer_param(params, "related_limit", default=100, maximum=100)
    parameters_offset = _integer_param(
        params, "parameters_offset", default=0, maximum=2**63 - 1
    )
    settings_offset = _integer_param(
        params, "settings_offset", default=0, maximum=2**63 - 1
    )
    model_offset = _integer_param(params, "model_offset", default=0, maximum=2**63 - 1)
    field_limit = _integer_param(
        params, "field_limit", default=16 * 1024, maximum=16 * 1024
    )
    request_after = _integer_param(params, "request_after", maximum=2**63 - 1)
    request_limit = _integer_param(params, "request_limit", default=30, maximum=30)
    windows_after = _integer_param(params, "windows_after", maximum=2**63 - 1)
    windows_limit = _integer_param(params, "windows_limit", default=30, maximum=30)
    assert message_offset is not None
    assert message_limit is not None
    assert input_offset is not None
    assert input_limit is not None
    assert response_offset is not None
    assert response_limit is not None
    assert related_offset is not None
    assert related_limit is not None
    assert parameters_offset is not None
    assert settings_offset is not None
    assert model_offset is not None
    assert field_limit is not None
    assert request_limit is not None
    assert windows_limit is not None
    if 0 in (message_limit, input_limit, response_limit, related_limit):
        raise DomainError(ErrorCode.INVALID_PARAMS, "message limits must be positive")
    if 0 in (field_limit, request_limit, windows_limit):
        raise DomainError(ErrorCode.INVALID_PARAMS, "history limits must be positive")
    run = context.api._scheduler.history.history_run(agent_id, sequence)
    if run is None:
        raise DomainError(ErrorCode.NOT_FOUND, f"Turn {sequence} does not exist")
    request_page = context.api._scheduler.history.model_request_summaries(
        agent_id,
        sequence,
        after=request_after,
        limit=request_limit + 1,
    )
    requests = request_page[:request_limit]
    requests_has_more = len(request_page) > request_limit
    window_page = context.api._scheduler.history.window_events(
        agent_id,
        after=windows_after,
        limit=windows_limit + 1,
        include_context=False,
    )
    windows = window_page[:windows_limit]
    windows_has_more = len(window_page) > windows_limit
    if requests:
        messages: dict[str, Any] = {
            "messages": [],
            "offset": 0,
            "total": 0,
            "next_offset": 0,
            "has_more": False,
        }
    else:
        legacy = context.api._scheduler.history.read_run_slice(
            agent_id, sequence, message_offset, 16 * 1024
        )
        if legacy is None:
            raise DomainError(ErrorCode.NOT_FOUND, f"Turn {sequence} does not exist")
        next_offset = legacy.offset + len(legacy.messages)
        messages = {
            "messages": [{"kind": "legacy", "content": legacy.messages}],
            "offset": legacy.offset,
            "total": legacy.total_length,
            "next_offset": next_offset,
            "has_more": next_offset < legacy.total_length,
        }
    result: dict[str, Any] = {
        "agent_id": agent_id,
        "run": _history_run_payload(run),
        "windows": [_window_event_payload(event) for event in windows],
        "windows_has_more": windows_has_more,
        "windows_next_after": (
            windows[-1].number if windows_has_more and windows else None
        ),
        "requests": [_request_summary_payload(item) for item in requests],
        "requests_has_more": requests_has_more,
        "requests_next_after": (
            requests[-1].ordinal if requests_has_more and requests else None
        ),
        "messages": messages,
        "missing": (
            [
                "provider_system_instructions",
                "model_input",
                "model_request_parameters",
                "model_settings",
                "model_identity",
                "request_window",
            ]
            if not requests and run.status != "running"
            else []
        ),
    }
    ordinal = _integer_param(params, "ordinal", maximum=2**63 - 1)
    if ordinal is None and requests:
        ordinal = requests[0].ordinal
    if ordinal is None:
        return result
    summary = context.api._scheduler.history.model_request_summary(
        agent_id, sequence, ordinal
    )
    if summary is None:
        raise DomainError(
            ErrorCode.NOT_FOUND, f"Model request {ordinal} does not exist"
        )
    input_page = context.api._scheduler.history.model_request_messages(
        agent_id, sequence, ordinal, "input", input_offset, input_limit
    )
    response_page = context.api._scheduler.history.model_request_messages(
        agent_id, sequence, ordinal, "response", response_offset, response_limit
    )
    related_page = context.api._scheduler.history.model_request_messages(
        agent_id, sequence, ordinal, "related", related_offset, related_limit
    )
    parameters_page = context.api._scheduler.history.model_request_field(
        agent_id,
        sequence,
        ordinal,
        "parameters",
        parameters_offset,
        field_limit,
    )
    settings_page = context.api._scheduler.history.model_request_field(
        agent_id, sequence, ordinal, "settings", settings_offset, field_limit
    )
    model_page = context.api._scheduler.history.model_request_field(
        agent_id, sequence, ordinal, "model", model_offset, field_limit
    )
    result["request"] = {
        "summary": _request_summary_payload(summary),
        "input": input_page,
        "parameters": parameters_page,
        "settings": settings_page,
        "model": model_page,
        "response": response_page if summary.response_count else None,
        "related": related_page,
    }
    if summary.status == "pending" and run.status != "running":
        result["missing"].append("model_response")
    return result


def agent_history_read(context: _Context, params: dict[str, Any]) -> Any:
    agent_id = _required_integer(params, "agent_id")
    sequence = _required_integer(params, "sequence")
    captured = context.api._scheduler.live.capture(agent_id)
    observation = context.api._scheduler.live.usage_capture(agent_id, turns=captured)
    with context.api._reading():
        result = agent_history_read_data(context, params)
        usage_data = context.api._scheduler.history.usage_display(
            observation,
            agent_id=agent_id,
            sequences=[sequence],
            cache=UsageCache.current("history"),
        )
    result["run"]["usage_metrics"] = usage_data["turns"].get(sequence)
    result["usage_version"] = _usage_version(usage_data)
    request = result.get("request")
    if request is not None:
        ordinal = request["summary"]["ordinal"]
        turn = next((item for item in captured if item.sequence == sequence), None)
        live_request = (
            next(
                (
                    item
                    for item in turn.requests
                    if item.ordinal == ordinal
                    and item.request_id == request["summary"]["request_id"]
                ),
                None,
            )
            if turn is not None
            else None
        )
        response_saved = request["response"] is not None
        if live_request is not None and turn is not None:
            stored = tuple(
                raw
                for source in ("response", "related")
                if request[source] is not None and request[source].offset == 0
                for raw in request[source].messages
            )
            coverage = live_coverage(stored, turn)
            response_saved = live_request.response_saved or any(
                item.handle.ordinal == ordinal
                and item.handle.request_id == live_request.request_id
                and item.response_version is not None
                and item.response_version == live_request.response_version
                for item in coverage
            )
            request["observation"] = {
                "runtime_epoch": turn.runtime_epoch,
                "live_revision": turn.live_revision,
                "request_id": live_request.request_id,
            }
        for source in ("input", "response", "related"):
            if request[source] is not None:
                request[source] = _render_message_page(request[source], source, ordinal)
        request["response_saved"] = response_saved
        if (
            live_request is not None
            and turn is not None
            and not response_saved
            and live_request.response_json is not None
        ):
            request["response"] = _render_live_page(
                live_request.response_json,
                ordinal,
                0,
                turn.runtime_epoch,
                "response",
                live_request.response_version,
                offset=int(params.get("response_offset", 0)),
                limit=int(params.get("response_limit", 100)),
            )
            result["missing"] = [
                item for item in result["missing"] if item != "model_response"
            ]
        for source in ("parameters", "settings", "model"):
            request[source] = _render_model_field_page(request[source], source, ordinal)
    return result


def agent_history_text_data(
    context: _Context, params: dict[str, Any]
) -> Callable[[], Any]:
    agent_id = _required_integer(params, "agent_id")
    context.api._human().authorize_agent_history(agent_id, include_deleted=True)
    sequence = _required_integer(params, "sequence")
    source = params.get("source")
    if source not in (
        "run",
        "input",
        "response",
        "related",
        "live",
        "parameters",
        "settings",
        "model",
    ):
        raise DomainError(ErrorCode.INVALID_PARAMS, "source is invalid")
    message_index = _required_integer(params, "message_index")
    offset = _integer_param(params, "offset", default=0, maximum=2**63 - 1)
    limit = _integer_param(params, "limit", default=16 * 1024, maximum=16 * 1024)
    assert offset is not None
    assert limit is not None
    if limit == 0:
        raise DomainError(ErrorCode.INVALID_PARAMS, "limit must be positive")
    path = params.get("path")
    if not isinstance(path, list) or any(
        isinstance(item, bool) or not isinstance(item, (str, int)) for item in path
    ):
        raise DomainError(ErrorCode.INVALID_PARAMS, "path must be a list")
    if source in ("parameters", "settings", "model"):
        ordinal = _integer_param(params, "ordinal")
        if ordinal is None:
            raise DomainError(ErrorCode.INVALID_PARAMS, "ordinal is required")
        page = context.api._scheduler.history.model_request_field(
            agent_id, sequence, ordinal, source, offset, limit
        )
        return partial(_render_model_field_page, page, source, ordinal)
    if source == "live":
        live_raw, _, _, _, _ = live_result(context, params)
        return partial(text_from_history, live_raw, message_index, path, offset, limit)
    raw = (
        context.api._scheduler.history.run_messages(agent_id, sequence)
        if source == "run"
        else None
    )
    index = message_index
    if source in ("input", "response", "related"):
        ordinal = _integer_param(params, "ordinal")
        if ordinal is None:
            raise DomainError(ErrorCode.INVALID_PARAMS, "ordinal is required")
        raw = context.api._scheduler.history.model_request_message(
            agent_id, sequence, ordinal, source, message_index
        )
        index = 0
    if raw is None:
        raise DomainError(ErrorCode.NOT_FOUND, "History content does not exist")
    return partial(text_from_history, raw, index, path, offset, limit)


def agent_history_text(context: _Context, params: dict[str, Any]) -> Any:
    if params.get("source") == "live":
        return agent_history_text_data(context, params)()
    with context.api._reading():
        render = agent_history_text_data(context, params)
    return render()


def agent_history_image_data(context: _Context, params: dict[str, Any]) -> Any:
    agent_id = _required_integer(params, "agent_id")
    context.api._human().authorize_agent_history(agent_id, include_deleted=True)
    sequence = _required_integer(params, "sequence")
    source = params.get("source")
    if source not in ("run", "input", "response", "related", "live"):
        raise DomainError(ErrorCode.INVALID_PARAMS, "source is invalid")
    message_index = _required_integer(params, "message_index")
    path = params.get("path")
    if not isinstance(path, list) or any(
        isinstance(item, bool) or not isinstance(item, (str, int)) for item in path
    ):
        raise DomainError(ErrorCode.INVALID_PARAMS, "path must be a list")
    ordinal = _integer_param(params, "ordinal")
    if source == "live":
        live_raw, _, _, _, _ = live_result(context, params)
        return live_raw, message_index, path
    raw = (
        context.api._scheduler.history.run_messages(agent_id, sequence)
        if source == "run"
        else None
    )
    if source in ("input", "response", "related"):
        if ordinal is None:
            raise DomainError(ErrorCode.INVALID_PARAMS, "ordinal is required")
        raw = context.api._scheduler.history.model_request_message(
            agent_id, sequence, ordinal, source, message_index
        )
        if raw is None:
            raise DomainError(ErrorCode.NOT_FOUND, "History content does not exist")
    if raw is None:
        raise DomainError(ErrorCode.NOT_FOUND, "History content does not exist")
    return (
        raw,
        0 if source in ("input", "response", "related") else message_index,
        path,
    )


def agent_history_image(context: _Context, params: dict[str, Any]) -> Any:
    if params.get("source") == "live":
        data = agent_history_image_data(context, params)
    else:
        with context.api._reading():
            data = agent_history_image_data(context, params)
    image = binary_from_history(*data)
    return {
        "media_type": image.media_type,
        "size": len(image.data),
        "identifier": image.identifier,
        "data": base64.b64encode(image.data).decode("ascii"),
    }


def usage_query(context: _Context, params: dict[str, Any]) -> Any:
    observation = context.api._scheduler.live.usage_capture()
    with context.api._reading():
        return context.api._human().usage_query(
            params, observation, UsageCache.current("usage")
        )


def usage_read(context: _Context, params: dict[str, Any]) -> Any:
    observation = context.api._scheduler.live.usage_capture()
    with context.api._reading():
        return context.api._human().usage_read(params["record_id"], observation)


def usage_advance(context: _Context, params: dict[str, Any]) -> Any:
    if (
        "initialization_version" in params
        and type(params["initialization_version"]) is not int
    ):
        raise DomainError(
            ErrorCode.INVALID_PARAMS,
            "Initialization version must be an integer",
        )
    result = context.api._human().usage_advance(
        params.get("limit", 100),
        initialization_version=params.get("initialization_version"),
    )
    context.api._dispatcher.emit(
        "usage.index_updated",
        {"dataset_revision": result["revision"], "ready": result["ready"]},
    )
    return result


def settings_get(context: _Context, params: dict[str, Any]) -> Any:
    section = str(params.get("section", "model"))
    values = context.settings.get_settings(section) or {}
    if section == "model":
        return ModelCatalog.restore(values).redacted()
    if section == "voice":
        if "mode" in values:
            values = context.settings.update_settings("voice", {})
        return VoiceConfig.restore(values).public()
    if section == "agent":
        return asdict(agent_parameters(values))
    if section == "observability":
        return {
            key: value
            for key, value in values.items()
            if key not in ("secret_key", "public_key")
        } | {"keys_set": bool(values.get("secret_key"))}
    if section == "execution":
        return context.api._scheduler.execution.status()
    return values


def settings_update(context: _Context, params: dict[str, Any]) -> Any:
    section = str(params.get("section", "model"))
    values = params.get("values", {})
    if not isinstance(values, dict):
        raise DomainError(
            ErrorCode.INVALID_SETTING, "Settings values must be an object"
        )
    if section == "execution":
        result = context.api._scheduler.execution.configure(
            values, lambda stored: context.settings.set_settings("execution", stored)
        )
        context.api._dispatcher.emit("settings.updated", {"section": section})
        return result
    updated = context.settings.update_settings(section, values)
    context.api._dispatcher.emit("settings.updated", {"section": section})
    if section == "model":
        return ModelCatalog.restore(updated).redacted()
    return settings_get(context, {"section": section})


def settings_list_models(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._list_models(
        dict(params), context.settings.get_settings("model")
    )


def settings_test_model(context: _Context, params: dict[str, Any]) -> Any:
    return context.api._test_model(dict(params), context.settings.get_settings("model"))
