from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractContextManager, nullcontext
from dataclasses import asdict
from functools import partial
from typing import Any, NamedTuple

from fora.adapters.files.tree import relative_path
from fora.adapters.jsonl.protocol import Dispatcher, RequestScope, Resource
from fora.adapters.model.config import ModelCatalog
from fora.adapters.voice.config import VoiceConfig
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.core.parameters import agent_parameters
from fora.ports.agent import SettingsStore
from fora.ports.usage import UsageCache
from fora.runtime.scheduler import Scheduler
from fora.runtime_info import RuntimeInfo
from fora.tools import AgentTools
from fora.tools.authorize import Actor

HUMAN_ID = 1


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
