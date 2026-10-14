from __future__ import annotations

import json
from dataclasses import replace
from types import SimpleNamespace

import pytest
from test_protocol import call, server

from fora.adapters.jsonl.protocol import Request, Resource
from fora.adapters.model.generation import evaluate_preview
from fora.adapters.sqlite.generation import SqliteGenerationStore
from fora.core.errors import DomainError
from fora.ports.agent import GenerationKey, GenerationUpdate, SendPreviewCandidate
from fora.tools import AgentTools, TurnBinding
from fora.tools.authorize import Actor

protocol_server = server


@pytest.fixture
def generated(protocol_server):
    dispatcher, output, deps = protocol_server
    agent = deps.store.create_member("agent", "Writer")
    discussion = deps.store.create_discussion("Drafts", [1, agent.id])
    second = deps.store.create_discussion("Second", [1, agent.id])
    run = deps.history.start_run(agent.id)
    handle = deps.history.start_model_request(
        agent.id, run.sequence, run.run_id, 1, (), "{}", "{}", "{}", True
    )
    key = GenerationKey(
        agent.id, run.sequence, handle.ordinal, 0, handle.request_id, run.run_id
    )
    body = "中😀文" * 10000
    update = GenerationUpdate(
        "tool-call",
        json.dumps({"part_kind": "tool-call", "args": body}),
        preview=SendPreviewCandidate(discussion.id, body),
    )
    saved = deps.history.generation.save(key, update)
    return SimpleNamespace(
        dispatcher=dispatcher,
        output=output,
        deps=deps,
        agent=agent,
        discussion=discussion,
        second=second,
        key=key,
        update=update,
        saved=saved,
    )


def request(records, method, **params):
    return call(records.dispatcher, records.output, method, **params)


def test_preview_snapshot_and_utf8_pages_are_versioned_and_read_only(generated):
    records = generated
    preview = records.saved.preview
    assert preview is not None
    before = records.deps.store._db._connection.total_changes
    result = request(
        records,
        "discussion.preview",
        discussion_id=records.discussion.id,
        preview_id=preview.preview_id,
    )["result"]
    assert result["preview"]["key"]["request_id"] == records.key.request_id
    assert result["body"]["total_bytes"] == 100000
    assert result["body"]["next_offset"] <= 16384
    assert result["body"]["has_more"]
    next_page = request(
        records,
        "discussion.preview.text",
        discussion_id=records.discussion.id,
        preview_id=preview.preview_id,
        revision=preview.revision,
        offset=result["body"]["next_offset"],
        limit=18,
    )["result"]
    assert next_page["offset"] == result["body"]["next_offset"]
    assert len(next_page["value"].encode()) <= 18
    assert records.deps.store._db._connection.total_changes == before
    assert records.deps.store.watermark(records.discussion.id, 1) == 0
    assert records.deps.store.pending(1) == ()
    assert records.deps.store.message_count(records.discussion.id) == 0


def test_generation_lists_have_exclusive_continuations(generated):
    records = generated
    for index in (1, 2):
        records.deps.history.generation.save(
            replace(records.key, part_index=index), records.update
        )
    first = request(
        records,
        "discussion.previews",
        discussion_id=records.discussion.id,
        limit=2,
    )["result"]
    second = request(
        records,
        "discussion.previews",
        discussion_id=records.discussion.id,
        limit=2,
        before=first["next_before"],
    )["result"]
    assert first["has_more"] and not second["has_more"]
    assert len(first["previews"]) == 2 and len(second["previews"]) == 1
    assert not {item["preview_id"] for item in first["previews"]} & {
        item["preview_id"] for item in second["previews"]
    }
    params = {
        "agent_id": records.agent.id,
        "sequence": records.key.sequence,
        "ordinal": records.key.ordinal,
        "limit": 2,
    }
    first = request(records, "agent.generation.parts", **params)["result"]
    second = request(
        records, "agent.generation.parts", **params, after=first["next_after"]
    )["result"]
    assert [item["key"]["part_index"] for item in first["parts"]] == [0, 1]
    assert [item["key"]["part_index"] for item in second["parts"]] == [2]
    assert second["next_after"] is None


def test_target_and_reader_permission_changes_remove_previews(generated):
    records = generated
    preview = records.saved.preview
    params = {
        "discussion_id": records.discussion.id,
        "preview_id": preview.preview_id,
    }
    moved = replace(
        records.update, preview=SendPreviewCandidate(records.second.id, "Moved")
    )
    records.deps.history.generation.save(records.key, moved)
    assert (
        request(records, "discussion.preview", **params)["error"]["code"] == "not_found"
    )
    params["discussion_id"] = records.second.id
    assert (
        request(records, "discussion.preview", **params)["result"]["body"]["value"]
        == "Moved"
    )
    records.deps.store.change_discussion_members(records.second.id, [1], remove=True)
    assert (
        request(records, "discussion.preview", **params)["error"]["code"]
        == "not_a_member"
    )
    assert (
        request(records, "discussion.previews", discussion_id=records.second.id)[
            "error"
        ]["code"]
        == "not_a_member"
    )


def test_part_reads_require_request_identity_revision_and_history_permission(generated):
    records = generated
    params = {
        "agent_id": records.agent.id,
        "sequence": records.key.sequence,
        "ordinal": records.key.ordinal,
        "part_index": records.key.part_index,
        "request_id": records.key.request_id,
        "revision": records.saved.part.revision,
        "limit": 18,
    }
    result = request(records, "agent.generation.text", **params)["result"]
    assert result["key"]["request_id"] == records.key.request_id
    assert result["next_offset"] <= 18
    params["request_id"] = "another-request"
    assert (
        request(records, "agent.generation.text", **params)["error"]["code"]
        == "not_found"
    )
    params["request_id"] = records.key.request_id
    records.deps.history.generation.save(records.key, records.update)
    assert (
        request(records, "agent.generation.text", **params)["error"]["code"]
        == "generation_changed"
    )
    params["agent_id"] = 1
    assert request(records, "agent.generation.text", **params)["error"]


def test_generation_fields_read_plain_unicode_with_revision_bound_pages(generated):
    records = generated
    params = {
        "agent_id": records.agent.id,
        "sequence": records.key.sequence,
        "ordinal": records.key.ordinal,
        "part_index": records.key.part_index,
        "request_id": records.key.request_id,
        "revision": records.saved.part.revision,
        "field": "args",
        "limit": 18,
    }
    first = request(records, "agent.generation.text", **params)["result"]
    assert first["field"] == "args" and first["value"] == "中😀文中😀"
    assert first["total_bytes"] == 100000 and first["next_offset"] == 17
    params["offset"] = first["next_offset"]
    second = request(records, "agent.generation.text", **params)["result"]
    assert first["value"] + second["value"] == "中😀文中😀文中😀文中"
    params["field"] = "content"
    assert (
        request(records, "agent.generation.text", **params)["error"]["code"]
        == "not_found"
    )
    payload = {"part_kind": "text", "content": "中文\\n😀"}
    saved = records.deps.history.generation.save(
        records.key, GenerationUpdate("text", json.dumps(payload))
    )
    params.update(revision=saved.part.revision, offset=0)
    page = request(records, "agent.generation.text", **params)["result"]
    assert page["value"] == payload["content"] and not page["has_more"]
    params["revision"] -= 1
    assert (
        request(records, "agent.generation.text", **params)["error"]["code"]
        == "generation_changed"
    )


def test_structured_tool_args_use_sqlite_json_field_decoding(generated):
    records = generated
    args = {"action": "send", "discussion_id": records.discussion.id, "body": "中文😀"}
    saved = records.deps.history.generation.save(
        records.key,
        GenerationUpdate(
            "tool-call", json.dumps({"part_kind": "tool-call", "args": args})
        ),
    )
    page = request(
        records,
        "agent.generation.text",
        agent_id=records.agent.id,
        sequence=records.key.sequence,
        ordinal=records.key.ordinal,
        part_index=records.key.part_index,
        request_id=records.key.request_id,
        revision=saved.part.revision,
        field="args",
    )["result"]
    assert json.loads(page["value"]) == args


@pytest.mark.parametrize(
    "suffix,reason",
    [
        (',"body":"other"}', "Tool parameters contain duplicate fields"),
        (" !}", "Tool parameters contain invalid JSON"),
    ],
)
def test_api_keeps_failed_parameter_preview_at_its_authorized_location(
    generated, suffix, reason
):
    records = generated
    args = json.dumps(
        {
            "action": "send",
            "discussion_id": records.discussion.id,
            "body": "@You readable 😀",
        }
    )[:-1]
    evaluation = evaluate_preview("discussion", args)
    original = records.deps.history.generation.save(
        records.key,
        GenerationUpdate(
            "tool-call", json.dumps({"args": args}), preview=evaluation.candidate
        ),
    ).preview
    assert original is not None
    malformed = args + suffix
    evaluation = evaluate_preview("discussion", malformed)
    assert evaluation.candidate is None and evaluation.error == reason
    params = {"discussion_id": records.discussion.id, "preview_id": original.preview_id}
    for status in ("generating", "completed", "failed"):
        failure = "Tool execution failed" if status == "failed" else None
        saved = records.deps.history.generation.save(
            records.key,
            GenerationUpdate(
                "tool-call",
                json.dumps({"args": malformed}),
                status=status,
                error=failure,
                preview_error=evaluation.error,
            ),
        )
        read = request(records, "discussion.preview", **params)["result"]
        assert read["preview"]["status"] == "failed"
        assert read["preview"]["error"] == (failure or reason)
        assert read["preview"]["key"]["request_id"] == records.key.request_id
        assert read["preview"]["revision"] == saved.part.revision
        assert read["body"]["value"] == "@You readable 😀"
        page = request(
            records, "discussion.preview.text", **params, revision=saved.part.revision
        )["result"]
        assert page["value"] == read["body"]["value"]
        listed = request(
            records, "discussion.previews", discussion_id=records.discussion.id
        )["result"]["previews"]
        assert len(listed) == 1 and listed[0]["preview_id"] == original.preview_id
    records.deps.store.change_discussion_members(
        records.discussion.id, [records.agent.id], remove=True
    )
    assert (
        request(records, "discussion.preview", **params)["error"]["code"] == "not_found"
    )
    assert (
        request(records, "discussion.previews", discussion_id=records.discussion.id)[
            "result"
        ]["previews"]
        == []
    )
    assert records.deps.store.message_count(records.discussion.id) == 0
    assert records.deps.store.pending(1) == ()


def test_sender_removal_hides_drafts_and_preserves_formal_mapping(generated):
    records = generated
    preview = records.saved.preview
    records.deps.store.change_discussion_members(
        records.discussion.id, [records.agent.id], remove=True
    )
    assert (
        request(records, "discussion.previews", discussion_id=records.discussion.id)[
            "result"
        ]["previews"]
        == []
    )
    records.deps.store.change_discussion_members(
        records.discussion.id, [records.agent.id]
    )
    with records.deps.history.transaction():
        message, _, _ = records.deps.store.submit_message(
            records.discussion.id, records.agent.id, "@You Published"
        )
        records.deps.history.generation.link(records.key, message)
    records.deps.store.change_discussion_members(
        records.discussion.id, [records.agent.id], remove=True
    )
    mapped = request(
        records, "discussion.previews", discussion_id=records.discussion.id
    )["result"]["previews"]
    assert len(mapped) == 1
    assert mapped[0]["preview_id"] == preview.preview_id
    assert mapped[0]["message_id"] == message.id and mapped[0]["status"] == "sent"
    snapshot = request(
        records,
        "discussion.preview",
        discussion_id=records.discussion.id,
        preview_id=preview.preview_id,
    )["result"]
    assert snapshot["body"]["value"] == message.body


@pytest.mark.parametrize(
    "method,params",
    [
        ("discussion.previews", {"limit": 0}),
        ("discussion.previews", {"limit": True}),
        ("discussion.previews", {"before": ["one"]}),
        ("discussion.preview", {"preview_id": 1}),
        ("discussion.preview.text", {"revision": True}),
        ("discussion.preview.text", {"revision": 0}),
        ("discussion.preview.text", {"limit": 65537}),
        ("discussion.preview.text", {"offset": -1}),
        ("agent.generation.parts", {"limit": 0}),
        ("agent.generation.parts", {"after": True}),
        ("agent.generation.text", {"part_index": False}),
        ("agent.generation.text", {"request_id": None}),
        ("agent.generation.text", {"field": "unknown"}),
        ("agent.generation.text", {"field": ["args"]}),
    ],
)
def test_generation_api_rejects_invalid_bounds_and_identity(generated, method, params):
    records = generated
    arguments = {
        "discussion_id": records.discussion.id,
        "preview_id": records.saved.preview.preview_id,
        "agent_id": records.agent.id,
        "sequence": records.key.sequence,
        "ordinal": records.key.ordinal,
        "part_index": records.key.part_index,
        "request_id": records.key.request_id,
        "revision": 1,
    }
    arguments.update(params)
    assert request(records, method, **arguments)["error"]["code"] == "invalid_params"


def bound_tools(records, on_change):
    return AgentTools(
        records.deps,
        Actor(records.agent.id, True),
        turn=TurnBinding(records.agent.id, records.key.sequence),
        on_change=on_change,
    )


def test_production_send_commits_mapping_and_notifies_once(generated):
    records = generated
    events = []
    tools = bound_tools(records, lambda name, payload: events.append((name, payload)))
    body = "@You Final text"
    first = tools.send_message(records.discussion.id, body, generation_key=records.key)
    preview = records.deps.history.generation.preview(records.key)
    assert preview.status == "sent" and preview.message_id == first["id"]
    assert first["preview_id"] == records.saved.preview.preview_id
    replay = tools.send_message(records.discussion.id, body, generation_key=records.key)
    assert replay["id"] == first["id"] and replay["mentioned"] == []
    assert len(events) == 1 and events[0][0] == "message.created"
    assert events[0][1]["preview_id"] == preview.preview_id
    assert records.deps.store.message_count(records.discussion.id) == 1
    assert len(records.deps.store.pending(1)) == 1
    assert len(records.deps.history.effects(records.agent.id)) == 1
    with pytest.raises(DomainError, match="different message content"):
        tools.send_message(records.discussion.id, "Changed", generation_key=records.key)
    with pytest.raises(DomainError, match="another Discussion"):
        tools.send_message(records.second.id, body, generation_key=records.key)


def test_production_mapping_failure_rolls_back_all_message_effects(
    generated, monkeypatch
):
    records = generated
    link = SqliteGenerationStore.link

    def fail_after_link(self, key, message):
        link(self, key, message)
        raise RuntimeError("mapping transaction failure")

    monkeypatch.setattr(SqliteGenerationStore, "link", fail_after_link)
    events = []
    tools = bound_tools(records, lambda name, payload: events.append((name, payload)))
    with pytest.raises(RuntimeError, match="mapping transaction failure"):
        tools.send_message(
            records.discussion.id, "@You Final", generation_key=records.key
        )
    assert events == []
    assert records.deps.store.message_count(records.discussion.id) == 0
    assert records.deps.store.pending(1) == ()
    assert records.deps.store.watermark(records.discussion.id, records.agent.id) == 0
    assert records.deps.history.generation.preview(records.key) == records.saved.preview
    assert records.deps.history.effects(records.agent.id) == ()


def test_lost_notification_recovers_mapping_and_replay_keeps_committed_identity(
    generated,
):
    records = generated
    notifications = []

    def fail_notification(name, payload):
        notifications.append((name, payload))
        raise RuntimeError("notification failure")

    tools = bound_tools(records, fail_notification)
    with pytest.raises(RuntimeError, match="notification failure"):
        tools.send_message(
            records.discussion.id, "@You Final", generation_key=records.key
        )
    committed = records.deps.history.generation.preview(records.key)
    assert committed.status == "sent"
    replay = tools.send_message(
        records.discussion.id, "@You Final", generation_key=records.key
    )
    assert replay["id"] == committed.message_id
    assert len(notifications) == 1
    restored = request(
        records,
        "discussion.preview",
        discussion_id=records.discussion.id,
        preview_id=committed.preview_id,
    )["result"]
    assert restored["preview"]["status"] == "sent"


def test_generation_send_context_requires_same_actor_and_turn(generated):
    records = generated
    tools = bound_tools(records, lambda name, payload: None)
    for key in (
        replace(records.key, agent_id=1),
        replace(records.key, sequence=records.key.sequence + 1),
        replace(records.key, request_id="unknown"),
    ):
        with pytest.raises(DomainError):
            tools.send_message(records.discussion.id, "@You Final", generation_key=key)
    human = AgentTools(records.deps, Actor(1, False))
    with pytest.raises(DomainError, match="this Turn"):
        human.send_message(records.discussion.id, "Final", generation_key=records.key)
    assert records.deps.store.message_count(records.discussion.id) == 0


def test_startup_recovery_interrupts_drafts_and_preserves_formal_messages(generated):
    records = generated
    sent_key = replace(records.key, part_index=1)
    records.deps.history.generation.save(sent_key, records.update)
    tools = bound_tools(records, lambda name, payload: None)
    tools.send_message(records.discussion.id, "@You Sent", generation_key=sent_key)
    sent = records.deps.history.generation.preview(sent_key)
    assert records.deps.history.mark_interrupted() == 1
    draft = records.deps.history.generation.preview(records.key)
    assert draft.status == "interrupted" and draft.error
    assert records.deps.history.generation.preview(sent_key) == sent
    assert records.deps.history.mark_interrupted() == 0
    assert records.deps.store.message_count(records.discussion.id) == 1


def test_generation_api_registers_read_only_resource_scopes(generated):
    records = generated
    for method in (
        "discussion.previews",
        "discussion.preview",
        "discussion.preview.text",
        "agent.generation.parts",
        "agent.generation.text",
    ):
        scope = records.dispatcher.scope(
            Request(
                1,
                method,
                {"discussion_id": records.discussion.id, "agent_id": records.agent.id},
            )
        )
        assert scope.writes == ()
        expected = (
            Resource("discussion", records.discussion.id)
            if method.startswith("discussion")
            else Resource("history", records.agent.id)
        )
        assert expected in scope.reads
