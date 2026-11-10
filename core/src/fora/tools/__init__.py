from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import AbstractContextManager, contextmanager, nullcontext
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from fora.core.actions import (
    BUILTIN,
    DISCUSSION_ARCHIVE,
    DISCUSSION_CREATE,
    DISCUSSION_MEMBERS,
    LIBRARY_WRITE,
    MEMBER_CREATE,
    MEMBER_DELETE,
    MEMBER_HISTORY,
    MEMBER_MODEL,
    MEMBER_PAUSE,
    MEMBER_RENAME,
    MEMBER_RESUME,
    MEMBER_RESUME_SAFETY,
    TOOLS_RUN,
    WORKSPACE_READ,
)
from fora.core.attachment import (
    MAX_IMAGE_BYTES,
    ImageData,
    ViewedImage,
    identifier,
)
from fora.core.discussion import Discussion, Message, validate_body, validate_topic
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError
from fora.core.member import validate_name
from fora.core.permissions import parse_entries, render_entry
from fora.ports.agent import HistoryStore, SettingsStore
from fora.ports.execution import (
    Access,
    ExecutionControl,
    ExecutionEnvironment,
    Sandbox,
)
from fora.ports.files import FileTree
from fora.ports.permissions import PermissionStore
from fora.ports.store import OrganizationStore, UnreadCounts
from fora.services.history import History
from fora.services.library import Library
from fora.services.uploads import Uploads
from fora.services.workspace import Workspace
from fora.tools.access import (
    AccessScope,
    real_path,
    require_protected,
    tree_node,
)
from fora.tools.authorize import Actor, Authorizer
from fora.tools.discussion_read import DiscussionReader, integer, read_position
from fora.tools.skills import LIBRARY, WORKSPACE, discover, load


@dataclass
class Dependencies:
    store: OrganizationStore
    history: HistoryStore
    settings: SettingsStore
    execution: ExecutionControl
    library_tree: FileTree
    workspace_tree_for: Callable[[int], FileTree]
    agent_directory_for: Callable[[int], Path]
    decode_image: Callable[[bytes], ImageData]
    uploads: Uploads | None = None
    reading: Callable[[], AbstractContextManager[None]] = nullcontext
    data_directory: Path | None = None


@dataclass(frozen=True)
class TurnBinding:
    agent_id: int
    sequence: int


class AgentTools:
    def __init__(
        self,
        deps: Dependencies,
        actor: Actor,
        authorizer: Authorizer | None = None,
        turn: TurnBinding | None = None,
        *,
        on_change: Callable[[str, dict[str, Any]], None] | None = None,
        agent_status: Callable[[int], dict[str, Any]] | None = None,
        pause: Callable[[int], dict[str, Any]] | None = None,
        resume: Callable[[int, bool], dict[str, Any]] | None = None,
        member_guard: Callable[[int], AbstractContextManager[object]] | None = None,
        member_deleted: Callable[[int], None] | None = None,
    ) -> None:
        self._deps = deps
        self._actor = actor
        self._auth = authorizer or Authorizer()
        self._turn = turn
        self._on_change = on_change or (lambda name, payload: None)
        self._agent_status = agent_status
        self._pause = pause
        self._resume = resume
        self._member_guard = member_guard
        self._member_deleted = member_deleted

    def _changed(self, name: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._on_change(name, payload)
        return payload

    def _record(self, tool: str, summary: str) -> None:
        if self._turn is None:
            return
        self._deps.history.record_effect(
            self._turn.agent_id, self._turn.sequence, tool, summary
        )

    def _require(self, *node: str) -> None:
        self._auth.check(self._actor, node)

    def _allows(self, *node: str) -> bool:
        return self._auth.allows(self._actor, node)

    def _discussion(self, discussion_id: int) -> Discussion:
        discussion = self._deps.store.get_discussion(discussion_id)
        if discussion is None:
            raise DomainError(
                ErrorCode.NOT_FOUND, f"Discussion {discussion_id} does not exist"
            )
        return discussion

    def _require_membership(self, discussion_id: int) -> None:
        if not self._discussion(discussion_id).has_member(self._actor.member_id):
            raise DomainError(
                ErrorCode.NOT_A_MEMBER,
                f"You do not belong to Discussion {discussion_id}",
            )

    def authorize_agent_history(
        self, agent_id: int, *, include_deleted: bool = False
    ) -> None:
        self._require(*MEMBER_HISTORY, str(agent_id))
        member = self._deps.store.get_member(agent_id)
        if (
            member is None
            or not member.is_agent
            or (member.deleted and not include_deleted)
        ):
            raise DomainError(ErrorCode.NOT_FOUND, f"Agent {agent_id} does not exist")

    def list_member_records(
        self, include_deleted: bool = False
    ) -> list[dict[str, Any]]:
        return [
            {
                "id": item.id,
                "type": item.type,
                "name": item.name,
                "state": item.state,
            }
            for item in self._deps.store.list_members(include_deleted=include_deleted)
        ]

    def list_members(self, include_deleted: bool = False) -> list[dict[str, Any]]:
        members = self.list_member_records(include_deleted)
        if self._agent_status is not None:
            for member in members:
                if member["type"] == "agent":
                    member.update(self._agent_status(member["id"]))
        return members

    def create_agent(
        self, name: str, model_config: object | None = None
    ) -> dict[str, Any]:
        self._require(*MEMBER_CREATE)
        validated = validate_name(name)
        result = self._deps.settings.create_agent_with_model(validated, model_config)
        return self._changed("member.created", result)

    def list_models(self) -> dict[str, object]:
        return self._deps.settings.model_catalog()

    def get_agent_model(self, agent_id: int) -> dict[str, object]:
        member = self._deps.store.get_member(agent_id)
        if member is None or not member.is_agent or member.deleted:
            raise DomainError(ErrorCode.NOT_FOUND, f"Agent {agent_id} does not exist")
        return self._deps.settings.agent_model_selection(agent_id)

    def set_agent_model(
        self, agent_id: int, model_config: object | None
    ) -> dict[str, object]:
        self._require(*MEMBER_MODEL, str(agent_id))
        if model_config is None:
            values: dict[str, object] = {}
        elif isinstance(model_config, Mapping):
            values = dict(model_config)
        else:
            dump = getattr(model_config, "model_dump", None)
            if not callable(dump):
                raise DomainError(
                    ErrorCode.INVALID_MODEL_CONFIG, "Invalid model configuration"
                )
            values = dict(dump(exclude_none=True))
        self._deps.settings.update_settings(
            "model",
            {"action": "set_agent", "id": agent_id, "values": values},
        )
        return self.get_agent_model(agent_id)

    def rename_member(self, member_id: int, name: str) -> dict[str, Any]:
        self._require(*MEMBER_RENAME, str(member_id))
        validated = validate_name(name)
        existing = self._deps.store.get_member(member_id)
        if existing is None:
            raise DomainError(ErrorCode.NOT_FOUND, f"Member {member_id} does not exist")
        if existing.name != validated and self._deps.store.name_taken(validated):
            raise DomainError(ErrorCode.DUPLICATE_NAME, "Member names must be unique")
        member = self._deps.store.rename_member(member_id, validated)
        return {"id": member.id, "name": member.name}

    def pause_agent(self, agent_id: int) -> dict[str, Any]:
        self._require(*MEMBER_PAUSE, str(agent_id))
        if self._pause is not None:
            return self._pause(agent_id)
        self._deps.store.set_agent_state(agent_id, "paused")
        return {"id": agent_id, "state": "paused"}

    def resume_agent(self, agent_id: int) -> dict[str, Any]:
        self._require(*MEMBER_RESUME, str(agent_id))
        can_recover = self._allows(*MEMBER_RESUME_SAFETY, str(agent_id))
        if self._resume is not None:
            return self._resume(agent_id, can_recover)
        member = self._deps.store.get_member(agent_id)
        if member is None or not member.is_agent:
            raise DomainError(ErrorCode.NOT_FOUND, f"Agent {agent_id} does not exist")
        if self._deps.history.pause_reason(agent_id) is not None and not can_recover:
            raise DomainError(
                ErrorCode.NOT_PERMITTED,
                "member:resume_safety is needed to recover this Agent",
            )
        runs = self._deps.history.run_summaries(agent_id, limit=1)
        if runs and runs[0].status == "running":
            raise DomainError(
                ErrorCode.AGENT_RUNNING,
                "Wait for the active Turn to finish before resuming",
            )
        if member.state == "paused":
            self._deps.history.reset_safety(agent_id)
        self._deps.store.set_agent_state(agent_id, "idle")
        return {"id": agent_id, "state": "idle"}

    def delete_agent(self, agent_id: int) -> dict[str, Any]:
        self._require(*MEMBER_DELETE, str(agent_id))
        with (
            self._member_guard(agent_id)
            if self._member_guard is not None
            else nullcontext()
        ):
            return self._delete_agent(agent_id)

    def _delete_agent(self, agent_id: int) -> dict[str, Any]:
        member = self._deps.store.get_member(agent_id)
        if member is None or not member.is_agent:
            raise DomainError(ErrorCode.NOT_FOUND, f"Agent {agent_id} does not exist")
        state = (
            self._agent_status(agent_id)["state"]
            if self._agent_status is not None
            else member.state
        )
        if state == "running":
            raise DomainError(
                ErrorCode.AGENT_RUNNING,
                "Pause the Agent and let its Turn finish before deleting",
            )
        store = self._auth.store
        if store is None:
            self._deps.settings.delete_agent_with_model(agent_id)
        else:
            with store.transaction():
                store.revoke_held(agent_id, self._actor.member_id)
                self._deps.settings.delete_agent_with_model(agent_id)
            self._changed("permissions.updated", {"holder_id": agent_id})
        if self._member_deleted is not None:
            self._member_deleted(agent_id)
        return {"id": agent_id, "deleted": True}

    def _permission_store(self) -> PermissionStore:
        store = self._auth.store
        if store is None:
            raise DomainError(
                ErrorCode.NOT_PERMITTED, "This organization does not track permissions"
            )
        return store

    def permission_catalog(self) -> list[dict[str, object]]:
        return [action.payload() for action in BUILTIN]

    def list_permissions(self, member_id: int | None = None) -> dict[str, Any]:
        permissions = self._permission_store().permissions()
        target = self._actor.member_id if member_id is None else member_id
        if self._deps.store.get_member(target) is None:
            raise DomainError(ErrorCode.NOT_FOUND, f"Member {target} does not exist")
        return {
            "member_id": target,
            "owner": target == permissions.owner_id,
            "grants": [grant.payload() for grant in permissions.grants_of(target)],
            "granted": [
                grant.payload()
                for grant in permissions.active()
                if grant.granted_by == target
            ],
        }

    def grant_permissions(self, member_id: int, entries: object) -> dict[str, Any]:
        parsed = parse_entries(entries)
        member = self._deps.store.get_member(member_id)
        if member is None or member.deleted:
            raise DomainError(ErrorCode.NOT_FOUND, f"Member {member_id} does not exist")
        if member_id == self._actor.member_id:
            raise DomainError(
                ErrorCode.INVALID_PERMISSION, "A Member cannot grant itself permissions"
            )
        store = self._permission_store()
        with store.transaction():
            permissions = store.permissions()
            if member_id == permissions.owner_id:
                raise DomainError(
                    ErrorCode.INVALID_PERMISSION, "The owner already holds everything"
                )
            parent = permissions.parent_for(self._actor.member_id, parsed)
            grant = store.add_grant(member_id, self._actor.member_id, parent, parsed)
        self._record(
            "permissions.grant",
            f"Member {member_id}: {', '.join(map(render_entry, grant.entries))}",
        )
        return self._changed("permissions.updated", grant.payload())

    def revoke_permissions(self, grant_id: int) -> dict[str, Any]:
        store = self._permission_store()
        with store.transaction():
            if not store.permissions().can_revoke(self._actor.member_id, grant_id):
                raise DomainError(
                    ErrorCode.NOT_PERMITTED,
                    f"Only the granter or someone upstream can revoke grant {grant_id}",
                )
            grant = store.revoke_grant(grant_id, self._actor.member_id)
        self._record("permissions.revoke", f"Grant {grant_id}")
        return self._changed("permissions.updated", grant.payload())

    def create_discussion(
        self, topic: str, member_ids: Sequence[int]
    ) -> dict[str, Any]:
        self._require(*DISCUSSION_CREATE)
        validated = validate_topic(topic)
        others = [
            item for item in dict.fromkeys(member_ids) if item != self._actor.member_id
        ]
        if not others:
            raise DomainError(
                ErrorCode.NEEDS_MEMBERS, "A Discussion needs at least one other Member"
            )
        known = {item.id for item in self._deps.store.list_members()}
        unknown = [item for item in others if item not in known]
        if unknown:
            raise DomainError(ErrorCode.NOT_FOUND, f"Unknown Members: {unknown}")
        discussion = self._deps.store.create_discussion(
            validated, [self._actor.member_id, *others]
        )
        return self._changed(
            "discussion.created",
            {
                "id": discussion.id,
                "topic": discussion.topic,
                "member_ids": sorted(discussion.member_ids),
            },
        )

    def list_discussions(
        self, include_archived: bool = False, *, limit: int | None = None
    ) -> list[dict[str, Any]]:
        if limit is not None and (type(limit) is not int or limit < 1):
            raise DomainError(
                ErrorCode.INVALID_PAGINATION, "limit must be an integer >= 1"
            )
        with self._deps.reading():
            counts = self._deps.store.unread_counts(self._actor.member_id)
            discussions = self._deps.store.list_discussions(
                member_id=self._actor.member_id,
                include_archived=include_archived,
                limit=limit,
            )
        return [
            {
                "id": item.id,
                "topic": item.topic,
                "member_ids": sorted(item.member_ids),
                "archived": item.archived,
                "unread": counts.get(item.id, UnreadCounts(0, 0)).unread,
                "mentions": counts.get(item.id, UnreadCounts(0, 0)).mentions,
            }
            for item in discussions
        ]

    def read_discussion(
        self,
        discussion_id: int,
        message_id: int | None = None,
        limit: int | None = None,
        *,
        before: int | None = None,
        after: int | None = None,
        max_chars: int | None = None,
        section: str = "messages",
        cursor: str | None = None,
        _result_size: Callable[[dict[str, Any]], int] | None = None,
    ) -> dict[str, Any]:
        integer("discussion_id", discussion_id, 1)
        effective_limit = integer("limit", 20 if limit is None else limit, 1, 100)
        budget = integer(
            "max_chars", 16000 if max_chars is None else max_chars, 2048, 64000
        )
        store = self._deps.store
        member_id = self._actor.member_id
        with self._deps.reading():
            summary = store.read_summary(discussion_id, member_id)
            position = read_position(
                summary, member_id, store, section, message_id, before, after, cursor
            )
            reader = DiscussionReader(
                store,
                summary,
                member_id,
                effective_limit,
                budget,
                (lambda attachment_id: self._uploads().files.path(attachment_id))
                if self._actor.is_agent
                else None,
                _result_size,
            )
            result = (
                reader.messages(position)
                if section == "messages"
                else reader.metadata(position)
            )
            reader.require_budget(result)
            complete = [
                item["id"]
                for item in result.get("messages", [])
                if item["body_complete"]
            ]
            through = max(complete) if complete else None
        store.finish_read(discussion_id, member_id, through)
        return result

    def _message(self, item: Message) -> dict[str, Any]:
        return {
            "id": item.id,
            "sender_id": item.sender_id,
            "sender_name": item.sender_name,
            "body": item.body,
            "created_at": item.created_at,
            "mentions": [asdict(mention) for mention in item.mentions],
            "attachments": [
                asdict(attachment)
                | (
                    {"path": self._uploads().files.path(attachment.id)}
                    if self._actor.is_agent
                    else {}
                )
                for attachment in item.attachments
            ],
        }

    def _human_discussion(self, discussion_id: int) -> None:
        if self._actor.is_agent:
            raise DomainError(
                ErrorCode.NOT_PERMITTED, "This operation is for the Human interface"
            )
        if type(discussion_id) is not int or discussion_id < 1:
            raise DomainError(
                ErrorCode.INVALID_DISCUSSION, "discussion_id must be a positive integer"
            )

    @staticmethod
    def _message_id(value: int) -> None:
        if type(value) is not int or value < 1:
            raise DomainError(
                ErrorCode.INVALID_MESSAGE, "message_id must be a positive integer"
            )

    def discussion_page(
        self,
        discussion_id: int,
        *,
        limit: int = 50,
        entry: bool = False,
        before: int | None = None,
        after: int | None = None,
        metadata: bool = False,
    ) -> dict[str, Any]:
        self._human_discussion(discussion_id)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise DomainError(
                ErrorCode.INVALID_PAGINATION, "limit must be an integer from 1 to 100"
            )
        if type(entry) is not bool or type(metadata) is not bool:
            raise DomainError(
                ErrorCode.INVALID_PAGINATION, "entry and metadata must be boolean"
            )
        for bound in (before, after):
            if bound is not None and (type(bound) is not int or bound < 0):
                raise DomainError(
                    ErrorCode.INVALID_PAGINATION, "bounds must be nonnegative integers"
                )
        if entry and (before is not None or after is not None):
            raise DomainError(
                ErrorCode.INVALID_PAGINATION, "entry cannot be combined with bounds"
            )
        if before is not None and after is not None and before <= after:
            raise DomainError(ErrorCode.INVALID_PAGINATION, "before must exceed after")
        page = self._deps.store.discussion_page(
            discussion_id,
            self._actor.member_id,
            limit=limit,
            entry=entry,
            before=before,
            after=after,
        )
        result: dict[str, Any] = {
            "id": discussion_id,
            "messages": [self._message(item) for item in page.messages],
            "read_through": page.read_through,
            "latest_id": page.latest_id,
            "has_before": page.has_before,
            "has_after": page.has_after,
            "previous_sender_id": page.previous_sender_id,
            "awaiting_ack": list(page.awaiting_ack),
            "acknowledged": list(page.acknowledged),
            "pending_count": page.pending_count,
        }
        if entry:
            result["first_unread_id"] = page.first_unread_id
        if metadata or entry:
            result["metadata"] = {
                "topic": page.discussion.topic,
                "archived": page.discussion.archived,
                "members": [{"id": key, "name": name} for key, name in page.members],
            }
        return result

    def mark_read(self, discussion_id: int, message_id: int) -> dict[str, Any]:
        self._human_discussion(discussion_id)
        self._message_id(message_id)
        watermark = self._deps.store.mark_read(
            discussion_id, self._actor.member_id, message_id
        )
        return {
            "discussion_id": discussion_id,
            "member_id": self._actor.member_id,
            "read_through": watermark,
        }

    def view_image(self, path: str) -> ViewedImage:
        execution = self._deps.execution.snapshot()
        scope = self._access_scope(execution)
        permissions = self._auth.permissions()
        if Path(path).is_absolute() and (
            scope.access(permissions, real_path(Path(path))) is Access.HIDDEN
        ):
            raise DomainError(
                ErrorCode.NOT_PERMITTED,
                f"Reading {path} is not permitted for this Member",
            )
        image = self._deps.decode_image(
            execution.read_file(
                path, MAX_IMAGE_BYTES, sandbox=scope.sandbox(permissions)
            )
        )
        self._record("view_image", f"Image path: {path}")
        return ViewedImage(path, image)

    def organization_uuid(self) -> str:
        return self._deps.store.organization_uuid()

    def _uploads(self) -> Uploads:
        assert self._deps.uploads is not None, "Uploads service is required"
        return self._deps.uploads

    def create_upload(
        self,
        discussion_id: int,
        client_upload_id: str,
        name: str,
        size: int,
        media_type: str,
    ) -> dict[str, Any]:
        self._human_discussion(discussion_id)
        self._require_membership(discussion_id)
        return asdict(
            self._uploads().create(
                discussion_id,
                self._actor.member_id,
                client_upload_id,
                name,
                size,
                media_type,
            )
        )

    def upload_status(self, upload_ids: Sequence[str]) -> list[dict[str, Any]]:
        if len(upload_ids) > 40:
            raise DomainError(ErrorCode.INVALID_UPLOADS, "Query at most 40 uploads")
        result = []
        for upload_id in upload_ids:
            record = self._uploads().store.get_upload(
                identifier(upload_id), self._actor.member_id
            )
            self._require_membership(record.discussion_id)
            result.append(
                asdict(self._uploads().status(record.id, self._actor.member_id))
            )
        return result

    def cancel_uploads(self, upload_ids: Sequence[str]) -> dict[str, int]:
        self.upload_status(upload_ids)
        for upload_id in upload_ids:
            self._uploads().cancel(upload_id, self._actor.member_id)
        return {"cancelled": len(upload_ids)}

    def send_status(self, discussion_id: int, client_message_id: str) -> dict[str, Any]:
        self._require_membership(discussion_id)
        state, result = self._deps.store.send_outcome(
            discussion_id, self._actor.member_id, identifier(client_message_id)
        )
        return {
            "state": state,
            "message": self._message(result) if result is not None else None,
        }

    def cancel_send(self, discussion_id: int, client_message_id: str) -> dict[str, Any]:
        self._require_membership(discussion_id)
        state, result = self._deps.store.cancel_send(
            discussion_id, self._actor.member_id, identifier(client_message_id)
        )
        return {
            "state": state,
            "message": self._message(result) if result is not None else None,
        }

    def send_message(
        self,
        discussion_id: int,
        body: str,
        *,
        mark_read: bool = True,
        attachment_ids: Sequence[str] = (),
        client_message_id: str | None = None,
    ) -> dict[str, Any]:
        self._require_membership(discussion_id)
        if type(mark_read) is not bool or (self._actor.is_agent and not mark_read):
            raise DomainError(
                ErrorCode.NOT_PERMITTED,
                "Only the Human interface can send without marking read",
            )
        validated = validate_body(body, has_attachments=bool(attachment_ids))
        if len(attachment_ids) > 10:
            raise DomainError(
                ErrorCode.INVALID_ATTACHMENTS, "Choose up to 10 distinct files"
            )
        state = "unknown"
        if client_message_id is not None:
            state, _ = self._deps.store.send_outcome(
                discussion_id, self._actor.member_id, identifier(client_message_id)
            )
        if state == "cancelled":
            raise DomainError(
                ErrorCode.SEND_CANCELLED, "This send attempt was cancelled"
            )
        if state == "unknown":
            try:
                for upload_id in attachment_ids:
                    self._uploads().status(
                        upload_id,
                        self._actor.member_id,
                        cleanup_invalid=not self._actor.is_agent,
                    )
            except (DomainError, OSError):
                if client_message_id is not None:
                    state, _ = self._deps.store.send_outcome(
                        discussion_id, self._actor.member_id, client_message_id
                    )
                    if state == "cancelled":
                        raise DomainError(
                            ErrorCode.SEND_CANCELLED, "This send attempt was cancelled"
                        ) from None
                raise
        options: dict[str, Any] = {
            "attachment_ids": attachment_ids,
            "client_message_id": client_message_id,
            "mark_read": mark_read,
        }
        message, mentions, created = self._deps.store.submit_message(
            discussion_id, self._actor.member_id, validated, **options
        )
        if not created:
            return {
                "discussion_id": discussion_id,
                "id": message.id,
                "created_at": message.created_at,
                "mentioned": [],
            }
        self._record(
            "send",
            f"Discussion {discussion_id}: message {message.id}"
            f" ({len(validated)} characters)",
        )
        return self._changed(
            "message.created",
            {
                "discussion_id": message.discussion_id,
                "id": message.id,
                "created_at": message.created_at,
                "mentioned": [item.member_id for item in mentions],
            },
        )

    def ack(self, discussion_id: int, message_ids: Sequence[int]) -> dict[str, Any]:
        self._require_membership(discussion_id)
        watermark = self._deps.store.watermark(discussion_id, self._actor.member_id)
        unread = [item for item in message_ids if item > watermark]
        if unread:
            raise DomainError(
                ErrorCode.NOT_READ, f"Read messages {unread} before acknowledging them"
            )
        acked = self._deps.store.ack(
            discussion_id, list(message_ids), self._actor.member_id
        )
        self._record("ack", f"Discussion {discussion_id}: {acked} acknowledged")
        return self._changed(
            "mention.acked", {"discussion_id": discussion_id, "acked": acked}
        )

    def revoke_ack(
        self, discussion_id: int, message_ids: Sequence[int]
    ) -> dict[str, Any]:
        self._require_membership(discussion_id)
        revoked = self._deps.store.revoke_ack(
            discussion_id, message_ids, self._actor.member_id
        )
        return self._changed(
            "mention.revoked", {"discussion_id": discussion_id, "revoked": revoked}
        )

    def _member_ids(self, member_ids: Sequence[int]) -> None:
        if any(type(item) is not int or item <= 0 for item in member_ids):
            raise DomainError(
                ErrorCode.INVALID_MEMBERS, "Member IDs must be positive integers"
            )

    def set_discussion_members(
        self, discussion_id: int, member_ids: Sequence[int]
    ) -> dict[str, Any]:
        self._require(*DISCUSSION_MEMBERS, str(discussion_id))
        self._discussion(discussion_id)
        self._member_ids(member_ids)
        updated = self._deps.store.set_discussion_members(discussion_id, member_ids)
        return self._changed(
            "discussion.updated",
            {"id": updated.id, "member_ids": sorted(updated.member_ids)},
        )

    def add_members(
        self, discussion_id: int, member_ids: Sequence[int]
    ) -> dict[str, Any]:
        self._require(*DISCUSSION_MEMBERS, str(discussion_id))
        self._member_ids(member_ids)
        updated = self._deps.store.change_discussion_members(discussion_id, member_ids)
        return self._changed(
            "discussion.updated",
            {"id": updated.id, "member_ids": sorted(updated.member_ids)},
        )

    def remove_members(
        self, discussion_id: int, member_ids: Sequence[int]
    ) -> dict[str, Any]:
        self._require(*DISCUSSION_MEMBERS, str(discussion_id))
        self._member_ids(member_ids)
        updated = self._deps.store.change_discussion_members(
            discussion_id, member_ids, remove=True
        )
        return self._changed(
            "discussion.updated",
            {"id": updated.id, "member_ids": sorted(updated.member_ids)},
        )

    def archive_discussion(
        self, discussion_id: int, archived: bool = True
    ) -> dict[str, Any]:
        self._require(*DISCUSSION_ARCHIVE, str(discussion_id))
        self._discussion(discussion_id)
        self._deps.store.set_archived(discussion_id, archived)
        return self._changed(
            "discussion.updated", {"id": discussion_id, "archived": archived}
        )

    def search_messages(
        self,
        query: str,
        sender_id: int | None = None,
        discussion_id: int | None = None,
    ) -> list[dict[str, Any]]:
        mine = {
            item.id
            for item in self._deps.store.list_discussions(
                member_id=self._actor.member_id, include_archived=True
            )
        }
        found = self._deps.store.search_messages(
            query, sender_id=sender_id, discussion_id=discussion_id
        )
        return [
            {
                "discussion_id": item.discussion_id,
                "id": item.id,
                "sender_name": item.sender_name,
                "body": item.body,
                "mentions": [asdict(mention) for mention in item.mentions],
                "attachments": self._message(item)["attachments"],
            }
            for item in found
            if item.discussion_id in mine
        ]

    def _access_scope(self, execution: ExecutionEnvironment) -> AccessScope:
        workspace = self._deps.workspace_tree_for(self._actor.member_id).root
        library = self._deps.library_tree.root
        for root in (workspace, library):
            root.mkdir(parents=True, exist_ok=True)
        data = self._deps.data_directory
        return AccessScope(
            writes=tuple(Path(item).resolve() for item in execution.write_directories),
            reads=tuple(Path(item).resolve() for item in execution.read_directories),
            library=library.resolve(),
            own=self._deps.agent_directory_for(self._actor.member_id).resolve(),
            workspace=workspace.resolve(),
            member_id=self._actor.member_id,
            data=data.resolve() if data is not None else None,
            uploads=(data / "uploads").resolve() if data is not None else None,
            links=execution.read_links,
        )

    def sandbox(self, execution: ExecutionEnvironment) -> Sandbox:
        return self._access_scope(execution).sandbox(self._auth.permissions())

    @contextmanager
    def _library_updates(self) -> Iterator[None]:
        library = self._library()
        before = library.snapshot()
        try:
            yield
        finally:
            after = library.snapshot()
            for path in library.changes(before, after):
                if path not in after:
                    self._changed("library.updated", {"path": path, "deleted": True})
                    continue
                self._changed(
                    "library.updated", {"path": path, "hash": self._library_hash(path)}
                )

    def run(
        self,
        argv: Sequence[str],
        cwd: str | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        self._require(*TOOLS_RUN)
        execution = self._deps.execution.snapshot()
        base = str(self._deps.agent_directory_for(self._actor.member_id))
        cwd = base if cwd is None else execution.resolve_path(cwd, base=base)
        sandbox = self.sandbox(execution)
        require_protected(sandbox)
        try:
            with self._library_updates():
                result = execution.run(
                    list(argv), cwd=cwd, timeout=timeout, sandbox=sandbox
                )
        finally:
            self._changed("workspace.changed", {"agent_id": self._actor.member_id})
        self._record("run", f"{' '.join(argv)} exited {result.exit_code}")
        return {
            "exit_code": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "truncated": result.truncated,
        }

    def edit(
        self,
        path: str,
        edits: Sequence[Mapping[str, object]],
        create: bool = False,
    ) -> dict[str, Any]:
        execution = self._deps.execution.snapshot()
        path = execution.resolve_path(
            path, base=str(self._deps.agent_directory_for(self._actor.member_id))
        )
        target = real_path(Path(path))
        scope = self._access_scope(execution)
        if scope.access(self._auth.permissions(), target) is not Access.WRITE:
            raise DomainError(
                ErrorCode.NOT_PERMITTED,
                f"Writing {path} is not permitted for this Member",
            )
        with self._library_updates():
            result = execution.edit(
                str(target), edits, write_directories=[str(target)], create=create
            )
        target = Path(result.path).resolve()
        workspace_root = self._deps.workspace_tree_for(
            self._actor.member_id
        ).root.resolve()
        if target.is_relative_to(workspace_root):
            self._changed(
                "workspace.changed",
                {
                    "agent_id": self._actor.member_id,
                    "path": target.relative_to(workspace_root).as_posix(),
                },
            )
        summary = (
            f"{result.path} (created)"
            if create
            else f"{result.path} ({result.replacements} replaced)"
        )
        self._record("edit", summary)
        return {
            "path": result.path,
            "diff": result.diff,
            "replacements": result.replacements,
            "created": create,
        }

    def _workspace(
        self, agent_id: int | None = None, path: str | None = None
    ) -> Workspace:
        if agent_id is None:
            agent_id = self._actor.member_id
        # 先确认成员存在，打开工作区会创建目录，不能为任意编号创建
        member = self._deps.store.get_member(agent_id)
        if member is None or member.deleted:
            raise DomainError(ErrorCode.NOT_FOUND, f"Member {agent_id} does not exist")
        tree = self._deps.workspace_tree_for(agent_id)
        self._require(*WORKSPACE_READ, str(agent_id), *tree_node(tree.root, path))
        return Workspace(tree)

    def list_workspace(
        self, path: str | None = None, *, agent_id: int | None = None
    ) -> list[dict[str, Any]]:
        owner = str(self._actor.member_id if agent_id is None else agent_id)
        allows = self._auth.checker(self._actor)
        return [
            {
                "path": item.path,
                "kind": item.kind,
                "size": item.size,
                "modified_at": item.modified_at,
            }
            for item in self._workspace(agent_id, path).list(path)
            if allows((*WORKSPACE_READ, owner, *item.path.split("/")))
        ]

    def read_workspace(
        self, path: str, *, agent_id: int | None = None
    ) -> dict[str, Any]:
        content, digest = self._workspace(agent_id, path).read(path)
        return {"path": path, "content": content, "hash": digest}

    def list_skills(self) -> list[dict[str, str]]:
        return [
            skill.payload()
            for skill in discover(
                self._deps.library_tree,
                self._deps.workspace_tree_for(self._actor.member_id),
            )
        ]

    def read_skill(self, name: str) -> dict[str, str]:
        try:
            return load(
                self._deps.workspace_tree_for(self._actor.member_id),
                WORKSPACE,
                name,
            )
        except DomainError as error:
            if error.code != ErrorCode.NOT_FOUND:
                raise
        return load(self._deps.library_tree, LIBRARY, name)

    @property
    def library_root(self) -> Path:
        return self._deps.library_tree.root

    def _library(self) -> Library:
        return Library(self._deps.library_tree)

    def _require_library(self, path: str, *, whole: bool = False) -> None:
        # 删除和移动作用在条目本身，不跟随符号链接，并且会带走下面的所有内容
        node = (
            *LIBRARY_WRITE,
            *tree_node(self._deps.library_tree.root, path, follow_symlinks=not whole),
        )
        if whole:
            self._auth.check_within(self._actor, node)
        else:
            self._require(*node)

    def _library_hash(self, path: str) -> str | None:
        try:
            return self._library().read(path).content_hash
        except DomainError:
            return None

    def list_library(self, path: str | None = None) -> list[dict[str, Any]]:
        return [
            {
                "path": item.path,
                "kind": item.kind,
                "size": item.size,
                "modified_at": item.modified_at,
            }
            for item in self._library().list(path)
        ]

    def read_library(self, path: str) -> dict[str, Any]:
        document = self._library().read(path)
        return {
            "path": document.path,
            "content": document.content,
            "hash": document.content_hash,
        }

    def write_library(
        self, path: str, content: str, expected_hash: str | None = None
    ) -> dict[str, Any]:
        self._require_library(path)
        try:
            entry = self._library().write(path, content, expected_hash=expected_hash)
        except DomainError as conflict:
            if conflict.code != ErrorCode.CONTENT_CHANGED:
                raise
            current, digest = self._library()._tree.read(path)
            return {
                "conflict": True,
                "path": path,
                "current_hash": digest,
                "current_content": current,
            }
        self._record("library.write", entry.path)
        return self._changed(
            "library.updated",
            {"path": entry.path, "hash": self._library_hash(entry.path)},
        )

    def edit_library(
        self, path: str, old_text: str, new_text: str, replace_all: bool = False
    ) -> dict[str, Any]:
        self._require_library(path)
        entry, diff = self._library().edit(
            path, old_text, new_text, replace_all=replace_all
        )
        self._record("library.edit", entry.path)
        updated = self._changed(
            "library.updated",
            {"path": entry.path, "hash": self._library_hash(entry.path)},
        )
        return {**updated, "diff": diff}

    def mkdir_library(self, path: str) -> dict[str, Any]:
        self._require_library(path)
        entry = self._library().mkdir(path)
        self._record("library.mkdir", entry.path)
        return self._changed("library.updated", {"path": entry.path, "hash": None})

    def delete_library(self, path: str) -> dict[str, Any]:
        self._require_library(path, whole=True)
        self._library().delete(path)
        self._record("library.delete", path)
        return self._changed("library.updated", {"path": path, "deleted": True})

    def move_library(self, source: str, destination: str) -> dict[str, Any]:
        self._require_library(source, whole=True)
        self._require_library(destination, whole=True)
        entry = self._library().move(source, destination)
        self._record("library.move", f"{source} to {entry.path}")
        self._changed("library.updated", {"path": source, "deleted": True})
        return self._changed(
            "library.updated",
            {"path": entry.path, "hash": self._library_hash(entry.path)},
        )

    def _history(self) -> History:
        return History(self._deps.history, self._actor.member_id)

    def search_history(self, query: str, offset: int = 0) -> dict[str, Any]:
        found, next_offset = self._history().search(query, offset)
        return {
            "turns": [
                {
                    "sequence": item.sequence,
                    "status": item.status,
                    "started_at": item.started_at,
                }
                for item in found
            ],
            "next_offset": next_offset,
        }

    def read_history(self, sequence: int, offset: int | None = None) -> dict[str, Any]:
        run = self._history().read(sequence, offset)
        if run is None:
            raise DomainError(ErrorCode.NOT_FOUND, f"Run {sequence} does not exist")
        next_offset = (
            run.offset + len(run.messages)
            if run.offset + len(run.messages) < run.total_length
            else None
        )
        return {
            "sequence": run.sequence,
            "status": run.status,
            "started_at": run.started_at,
            "messages": run.messages,
            "offset": run.offset,
            "total_length": run.total_length,
            "next_offset": next_offset,
        }
