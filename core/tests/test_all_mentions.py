from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, Event

import pytest
from pydantic_ai import ModelMessagesTypeAdapter
from pydantic_ai.messages import (
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import FunctionModel

from fora.adapters.execution.manager import ExecutionManager
from fora.adapters.files.tree import DirectoryTree
from fora.adapters.files.uploads import DirectoryUploads, decode_image
from fora.adapters.jsonl.api import Api
from fora.adapters.jsonl.protocol import Dispatcher, Request
from fora.adapters.model.runner import PydanticModelRunner
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.core.discussion import MessageMention
from fora.core.errors import DomainError
from fora.runtime.reminder import TurnOutcome, TurnRequest
from fora.runtime.scheduler import Scheduler
from fora.services.uploads import Uploads
from fora.tools import AgentTools, Dependencies, TurnBinding
from fora.tools.authorize import Actor

CLIENT_ID = "00000000-0000-4000-8000-000000000001"


@pytest.fixture
def world(tmp_path: Path):
    store = SqliteStore(tmp_path / "fora.sqlite3")
    history = SqliteAgentStore(store._db)
    store.create_member("human", "You")
    store.create_member("agent", "All Hands")
    store.create_member("agent", "Other")
    store.create_member("agent", "Newcomer")

    def directory(member_id: int) -> Path:
        path = tmp_path / "agents" / str(member_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    deps = Dependencies(
        store=store,
        history=history,
        settings=history,
        execution=ExecutionManager(enforce=False),
        agent_directory_for=directory,
        decode_image=decode_image,
        library_tree=DirectoryTree(tmp_path / "library"),
        workspace_tree_for=lambda member_id: DirectoryTree(
            directory(member_id) / "workspace"
        ),
        uploads=Uploads(store, DirectoryUploads(tmp_path / "uploads")),
    )
    yield deps
    deps.execution.close()
    store.close()


@pytest.mark.parametrize("sender_id", [1, 2])
@pytest.mark.parametrize("entry", ["submit", "append"])
def test_store_all_sends_preserve_recipients_and_positions(world, sender_id, entry):
    store = world.store
    store.set_agent_state(3, "paused")
    room = store.create_discussion("Everyone", [1, 2, 3])
    body = "😀 @ALL @all @Other"
    if entry == "submit":
        sent, mentions, created = store.submit_message(room.id, sender_id, body)
        assert created
    else:
        sent, mentions = store.append_message(room.id, sender_id, body)
    expected = tuple(
        MessageMention(index, 2, 4) for index in (1, 2, 3) if index != sender_id
    )
    assert sent.mentions == expected
    assert (
        tuple(
            MessageMention(item.member_id, item.position, item.length)
            for item in mentions
        )
        == expected
    )
    assert store.messages(room.id)[0].mentions == expected
    assert store.search_messages("@ALL")[0].mentions == expected
    assert store.pending(sender_id) == ()
    assert store.pending(4) == ()
    for recipient in expected:
        pending = store.pending(recipient.member_id)
        assert len(pending) == 1
        assert pending[0].message_id == sent.id
        page = store.discussion_page(room.id, recipient.member_id, entry=True, limit=50)
        assert page.messages[0].mentions == expected
        assert page.awaiting_ack == (sent.id,)


def test_saved_all_recipients_survive_membership_changes_and_restart(world, tmp_path):
    store = world.store
    room = store.create_discussion("History", [1, 2, 3])
    sent, _, _ = store.submit_message(room.id, 1, "@all", client_message_id=CLIENT_ID)
    expected = (MessageMention(2, 0, 4), MessageMention(3, 0, 4))
    store.rename_member(2, "Renamed")
    store.set_discussion_members(room.id, [1, 2, 4])
    store.delete_member(3)
    assert store.pending(4) == ()
    assert store.pending(3) == ()
    assert len(store.pending(2)) == 1
    store.set_discussion_members(room.id, [1, 4])
    assert store.pending(2) == ()
    store.set_discussion_members(room.id, [1, 2, 4])
    assert len(store.pending(2)) == 1
    for connection in (store, SqliteStore(tmp_path / "fora.sqlite3")):
        try:
            assert connection.messages(room.id)[0].mentions == expected
            assert connection.send_outcome(room.id, 1, CLIENT_ID) == ("sent", sent)
            replay, mentioned, created = connection.submit_message(
                room.id, 1, "@all", client_message_id=CLIENT_ID
            )
            assert replay == sent
            assert replay.mentions == expected
            assert mentioned == ()
            assert not created
            assert connection.message_count(room.id) == 1
        finally:
            if connection is not store:
                connection.close()


@pytest.mark.parametrize("recorded", [False, True])
def test_legacy_all_body_keeps_saved_meaning(world, recorded):
    store = world.store
    store.rename_member(2, "all")
    room = store.create_discussion("Legacy", [1, 2, 3])
    with store._write() as db:
        db.execute(
            "INSERT INTO messages VALUES (?, 1, 1, 'You', '@all', 'old')", (room.id,)
        )
        if recorded:
            db.execute("INSERT INTO mentions VALUES (?, 1, 2, 0, 4)", (room.id,))
    expected = (MessageMention(2, 0, 4),) if recorded else ()
    assert store.messages(room.id)[0].mentions == expected
    assert store.pending(3) == ()
    store.append_message(room.id, 1, "@all")
    assert store.messages(room.id)[0].mentions == expected
    assert store.messages(room.id)[1].mentions == (
        MessageMention(2, 0, 4),
        MessageMention(3, 0, 4),
    )


@pytest.mark.parametrize("mutation", ["join", "remove", "delete", "rename"])
@pytest.mark.parametrize("send_first", [False, True])
def test_all_uses_member_facts_in_the_serialized_send_transaction(
    world, tmp_path, mutation, send_first
):
    store = world.store
    other = SqliteStore(tmp_path / "fora.sqlite3")
    room = store.create_discussion("Concurrent", [1, 2, 3])
    body = "@All Hands" if mutation == "rename" else "@all"
    before = [2] if mutation == "rename" else [2, 3]
    after = {
        "join": [2, 3, 4],
        "remove": [3],
        "delete": [3],
        "rename": [2, 3],
    }[mutation]
    began = Event()

    def change(connection):
        if mutation == "join":
            connection.set_discussion_members(room.id, [1, 2, 3, 4])
        elif mutation == "remove":
            connection.set_discussion_members(room.id, [1, 3])
        elif mutation == "delete":
            connection.delete_member(2)
        else:
            connection.rename_member(2, "Renamed")

    def send(connection):
        return connection.submit_message(room.id, 1, body)

    other._db._connection.set_trace_callback(
        lambda sql: began.set() if sql == "BEGIN IMMEDIATE" else None
    )
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            with store._write():
                if send_first:
                    message, _, _ = send(store)
                    waiting = pool.submit(change, other)
                else:
                    change(store)
                    waiting = pool.submit(send, other)
                assert began.wait(timeout=10)
                assert not waiting.done()
            result = waiting.result(timeout=10)
            if not send_first:
                message, _, _ = result
        expected = before if send_first else after
        assert [item.member_id for item in message.mentions] == expected
        assert store.messages(room.id)[0].mentions == message.mentions
        assert [
            item.member_id for item in store.messages(room.id)[0].mentions
        ] == expected
    finally:
        other.close()


def test_concurrent_all_requests_reuse_one_saved_receipt(world, tmp_path):
    store = world.store
    other = SqliteStore(tmp_path / "fora.sqlite3")
    room = store.create_discussion("Replay", [1, 2, 3])
    barrier = Barrier(2)

    def send(connection):
        barrier.wait(timeout=10)
        return connection.submit_message(
            room.id, 1, "@all", client_message_id=CLIENT_ID
        )

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(send, (store, other)))
        assert sum(created for _, _, created in results) == 1
        assert results[0][0] == results[1][0]
        assert len(results[0][0].mentions) == 2
        assert store.message_count(room.id) == 1
        assert len(store.pending(2)) == 1
        assert len(store.pending(3)) == 1
    finally:
        other.close()


def test_agent_tools_all_receipt_events_and_effects(world):
    store = world.store
    room = store.create_discussion("Tools", [1, 2, 3])
    run = world.history.start_run(2)
    events = []
    tools = AgentTools(
        world,
        Actor(2, True),
        turn=TurnBinding(2, run.sequence),
        on_change=lambda name, payload: events.append((name, payload)),
    )
    first = tools.send_message(room.id, "@all", client_message_id=CLIENT_ID)
    assert first["mentioned"] == [1, 3]
    store.rename_member(3, "Renamed")
    store.set_discussion_members(room.id, [1, 2, 4])
    replay = tools.send_message(room.id, "@all", client_message_id=CLIENT_ID)
    assert replay["id"] == first["id"]
    assert replay["mentioned"] == []
    assert [
        item["member_id"]
        for item in tools.send_status(room.id, CLIENT_ID)["message"]["mentions"]
    ] == [1, 3]
    assert len(events) == 1
    assert events[0][0] == "message.created"
    assert len(world.history.effects(2, sequences=[run.sequence])) == 1
    assert store.pending(4) == ()
    with pytest.raises(DomainError) as error:
        tools.send_message(room.id, "@all changed", client_message_id=CLIENT_ID)
    assert error.value.code == "message_conflict"
    assert len(events) == 1


@pytest.mark.parametrize("cancel_first", [False, True])
def test_all_send_cancellation_keeps_receipt_and_side_effects(world, cancel_first):
    room = world.store.create_discussion("Cancellation", [1, 2, 3])
    run = world.history.start_run(2)
    events = []
    tools = AgentTools(
        world,
        Actor(2, True),
        turn=TurnBinding(2, run.sequence),
        on_change=lambda name, payload: events.append((name, payload)),
    )
    if cancel_first:
        assert tools.cancel_send(room.id, CLIENT_ID) == {
            "state": "cancelled",
            "message": None,
        }
        with pytest.raises(DomainError) as failure:
            tools.send_message(room.id, "@all", client_message_id=CLIENT_ID)
        assert failure.value.code == "send_cancelled"
        assert world.store.messages(room.id) == ()
        assert world.store.watermark(room.id, 2) == 0
        assert world.store.pending(1) == ()
        assert world.store.pending(3) == ()
        assert events == []
        assert world.history.effects(2, sequences=[run.sequence]) == ()
    else:
        sent = tools.send_message(room.id, "@all", client_message_id=CLIENT_ID)
        cancelled = tools.cancel_send(room.id, CLIENT_ID)
        assert cancelled["state"] == "sent"
        assert cancelled["message"]["id"] == sent["id"]
        assert cancelled["message"]["mentions"] == [
            {"member_id": 1, "position": 0, "length": 4},
            {"member_id": 3, "position": 0, "length": 4},
        ]
        replay = tools.send_message(room.id, "@all", client_message_id=CLIENT_ID)
        assert replay["mentioned"] == []
        assert world.store.message_count(room.id) == 1
        assert len(events) == 1
        assert len(world.history.effects(2, sequences=[run.sequence])) == 1
        assert len(world.store.pending(1)) == 1
        assert len(world.store.pending(3)) == 1


def test_all_receipt_attachment_conflict_preserves_saved_recipients(world):
    room = world.store.create_discussion("Attachment conflict", [1, 2, 3])
    sent, _, _ = world.store.submit_message(
        room.id, 2, "@all", client_message_id=CLIENT_ID
    )
    with pytest.raises(DomainError) as failure:
        world.store.submit_message(
            room.id,
            2,
            "@all",
            client_message_id=CLIENT_ID,
            attachment_ids=["00000000-0000-4000-8000-000000000002"],
        )
    assert failure.value.code == "message_conflict"
    assert world.store.send_outcome(room.id, 2, CLIENT_ID) == ("sent", sent)
    assert world.store.messages(room.id) == (sent,)
    assert len(world.store.pending(1)) == 1
    assert len(world.store.pending(3)) == 1


class HandlingRunner:
    def __init__(self):
        self.requests = []

    def check_available(self, agent_id):
        pass

    def validate_history(self, raw):
        ModelMessagesTypeAdapter.validate_json(raw)

    def run(self, request, tools):
        self.requests.append(request)
        for item in request.reminder.items:
            tools.read_discussion(item.discussion_id, message_id=item.message_id)
            tools.ack(item.discussion_id, [item.message_id])
        return TurnOutcome(messages_json="[]")


def test_scheduler_keeps_paused_all_pending_and_excludes_sender(world):
    world.store.set_agent_state(3, "paused")
    room = world.store.create_discussion("Paused", [1, 2, 3])
    runner = HandlingRunner()
    scheduler = Scheduler(world, runner)
    try:
        sent = scheduler.tools_for(2).send_message(room.id, "@all")
        assert sent["mentioned"] == [1, 3]
        assert world.store.pending(2) == ()
        assert scheduler.run_turn(2) is None
        assert scheduler.run_turn(3) is None
        assert len(world.store.pending(3)) == 1
        scheduler.resume(3)
        assert scheduler.run_turn(3) is not None
        assert len(runner.requests) == 1
        assert world.store.pending(3) == ()
        scheduler.tools_for(3).revoke_ack(room.id, [sent["id"]])
        assert len(world.store.pending(3)) == 1
    finally:
        scheduler.stop()


def test_human_dispatcher_all_and_empty_receivers_keep_actual_mentions(world):
    dispatcher = Dispatcher()
    scheduler = Scheduler(world, HandlingRunner())
    Api(scheduler, dispatcher)
    frames = []
    try:
        room = world.store.create_discussion("Dispatcher", [1, 2, 3])
        dispatcher.handle(
            Request(1, "discussion.send", {"discussion_id": room.id, "body": "@all"}),
            frames.append,
        )
        assert frames[-1]["result"]["mentioned"] == [2, 3]
        dispatcher.handle(
            Request(2, "discussion.read", {"discussion_id": room.id}), frames.append
        )
        assert frames[-1]["result"]["messages"][0]["mentions"] == [
            {"member_id": 2, "position": 0, "length": 4},
            {"member_id": 3, "position": 0, "length": 4},
        ]
        alone = world.store.create_discussion("Alone", [1])
        dispatcher.handle(
            Request(3, "discussion.send", {"discussion_id": alone.id, "body": "@all"}),
            frames.append,
        )
        assert frames[-1]["result"]["mentioned"] == []
        assert world.store.messages(alone.id)[0].mentions == ()
        assert world.store.pending(1) == ()
        outsider = world.store.create_discussion("Private", [2, 3])
        dispatcher.handle(
            Request(
                4, "discussion.send", {"discussion_id": outsider.id, "body": "@all"}
            ),
            frames.append,
        )
        assert frames[-1]["error"]["code"] == "not_a_member"
        assert world.store.messages(outsider.id) == ()
    finally:
        scheduler.stop()


def test_model_discussion_tool_sends_all_with_real_store(world):
    room = world.store.create_discussion("Model", [1, 2, 3])
    world.settings.set_settings(
        "model",
        {
            "api_type": "openai-chat",
            "base_url": "https://example.invalid/v1",
            "api_key": "unused",
            "model": "local",
        },
    )
    run = world.history.start_run(2)
    returns = []

    def respond(messages, info):
        returned = [
            part
            for message in messages
            for part in message.parts
            if isinstance(part, ToolReturnPart) and part.tool_name == "discussion"
        ]
        if not returned:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "discussion",
                        {"action": "send", "discussion_id": room.id, "body": "@all"},
                        "all-send",
                    )
                ]
            )
        returns.append(returned[-1].content)
        return ModelResponse(parts=[TextPart("Sent")])

    runner = PydanticModelRunner(
        world.settings, build_model=lambda config: FunctionModel(respond)
    )
    request = TurnRequest(
        agent_id=2,
        sequence=run.sequence,
        agent_name="All Hands",
        prompt="Send the requested message",
        reminder=None,
        history_json="[]",
        resident="",
        environment=lambda: "environment",
        ephemeral=lambda: "",
        persist=lambda raw: world.history.save_progress(2, run.sequence, raw),
    )
    outcome = runner.run(
        request, AgentTools(world, Actor(2, True), turn=TurnBinding(2, run.sequence))
    )
    assert outcome.error is None
    assert returns[0]["mentioned"] == [1, 3]
    assert [item.member_id for item in world.store.messages(room.id)[0].mentions] == [
        1,
        3,
    ]
    saved = ModelMessagesTypeAdapter.validate_json(world.history.latest_messages(2))
    assert any(
        isinstance(part, ToolReturnPart) and part.tool_name == "discussion"
        for message in saved
        for part in message.parts
    )


def store_snapshot(store):
    tables = (
        "members",
        "discussions",
        "discussion_members",
        "messages",
        "mentions",
        "message_receipts",
        "message_attachments",
        "uploads",
        "watermarks",
        "acks",
    )
    return {
        table: tuple(
            tuple(row)
            for row in store._db.execute(f"SELECT * FROM {table} ORDER BY rowid")
        )
        for table in tables
    }


@pytest.mark.parametrize("entry", ["store", "tools"])
@pytest.mark.parametrize("change", ["none", "removed", "deleted"])
def test_required_all_without_receivers_preserves_state(world, entry, change):
    store = world.store
    room = store.create_discussion("No receivers", [2] if change == "none" else [2, 3])
    if change == "removed":
        store.set_discussion_members(room.id, [2])
    elif change == "deleted":
        store.delete_member(3)
    run = world.history.start_run(2)
    events = []
    tools = AgentTools(
        world,
        Actor(2, True),
        turn=TurnBinding(2, run.sequence),
        on_change=lambda name, payload: events.append((name, payload)),
    )
    before = store_snapshot(store)
    with pytest.raises(DomainError) as failure:
        if entry == "store":
            store.submit_message(
                room.id,
                2,
                "@all @All Hands @all",
                client_message_id=CLIENT_ID,
                mark_read=True,
            )
        else:
            tools.send_message(
                room.id, "@all @All Hands @all", client_message_id=CLIENT_ID
            )
    assert failure.value.code == "mention_required"
    assert store_snapshot(store) == before
    assert store.send_outcome(room.id, 2, CLIENT_ID) == ("unknown", None)
    assert events == []
    assert world.history.effects(2, sequences=[run.sequence]) == ()


@pytest.mark.parametrize("file_state", ["ready", "missing", "changed"])
def test_required_all_attachment_preflight_preserves_rejected_state(world, file_state):
    store = world.store
    room = store.create_discussion("Attachment preflight", [2])
    uploads = world.uploads
    assert uploads is not None
    data = b"same"
    upload = uploads.create(room.id, 2, CLIENT_ID, "proof.txt", len(data), "text/plain")
    active, target = uploads.begin(upload.id, 2)
    with target:
        target.write(data)
    attachment = uploads.complete(active)
    uploads.end(active)
    path = Path(uploads.files.path(upload.id))
    if file_state == "missing":
        path.unlink()
    elif file_state == "changed":
        path.write_bytes(b"diff")
    run = world.history.start_run(2)
    events = []
    tools = AgentTools(
        world,
        Actor(2, True),
        turn=TurnBinding(2, run.sequence),
        on_change=lambda name, payload: events.append((name, payload)),
    )
    before = store_snapshot(store)
    with pytest.raises(DomainError) as failure:
        tools.send_message(
            room.id,
            "@all",
            attachment_ids=[upload.id],
            client_message_id=CLIENT_ID,
        )
    assert (
        failure.value.code
        == {
            "ready": "mention_required",
            "missing": "attachment_missing",
            "changed": "attachment_changed",
        }[file_state]
    )
    assert store_snapshot(store) == before
    assert store.send_outcome(room.id, 2, CLIENT_ID) == ("unknown", None)
    assert world.history.effects(2, sequences=[run.sequence]) == ()
    assert events == []
    if file_state == "missing":
        assert not path.exists()
    else:
        assert path.read_bytes() == (data if file_state == "ready" else b"diff")
    if file_state == "ready":
        store.set_discussion_members(room.id, [1, 2])
        sent = tools.send_message(
            room.id,
            "@all",
            attachment_ids=[upload.id],
            client_message_id=CLIENT_ID,
        )
        assert sent["mentioned"] == [1]
        assert store.messages(room.id)[0].attachments == (attachment,)
        assert store.get_upload(upload.id, 2).state == "attached"
        assert len(world.history.effects(2, sequences=[run.sequence])) == 1
        assert len(events) == 1
        assert len(store.pending(1)) == 1


def test_model_retries_all_without_receivers_and_sends_to_real_members(world):
    alone = world.store.create_discussion("Alone", [2])
    room = world.store.create_discussion("Recipients", [1, 2, 3])
    world.settings.set_settings(
        "model",
        {
            "api_type": "openai-chat",
            "base_url": "https://example.invalid/v1",
            "api_key": "unused",
            "model": "local",
        },
    )
    run = world.history.start_run(2)
    retries = []
    returned = []

    def respond(messages, info):
        for part in messages[-1].parts:
            if isinstance(part, RetryPromptPart):
                retries.append(part.content)
                assert world.store.message_count(alone.id) == 0
                assert world.store.watermark(alone.id, 2) == 0
                assert world.history.effects(2, sequences=[run.sequence]) == ()
            elif isinstance(part, ToolReturnPart):
                returned.append(part.content)
        if returned:
            return ModelResponse(parts=[TextPart("Sent")])
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "discussion",
                    {
                        "action": "send",
                        "discussion_id": room.id if retries else alone.id,
                        "body": "@all",
                    },
                    "fixed-all" if retries else "empty-all",
                )
            ]
        )

    runner = PydanticModelRunner(
        world.settings, build_model=lambda config: FunctionModel(respond)
    )
    request = TurnRequest(
        agent_id=2,
        sequence=run.sequence,
        agent_name="All Hands",
        prompt="Send the requested message",
        reminder=None,
        history_json="[]",
        resident="",
        environment=lambda: "environment",
        ephemeral=lambda: "",
        persist=lambda raw: world.history.save_progress(2, run.sequence, raw),
    )
    outcome = runner.run(
        request, AgentTools(world, Actor(2, True), turn=TurnBinding(2, run.sequence))
    )
    assert outcome.error is None
    assert len(retries) == 1 and "mention_required" in str(retries[0])
    assert returned[0]["mentioned"] == [1, 3]
    assert world.store.message_count(alone.id) == 0
    assert world.store.message_count(room.id) == 1
    assert len(world.history.effects(2, sequences=[run.sequence])) == 1
    assert world.store.messages(room.id)[0].mentions == (
        MessageMention(1, 0, 4),
        MessageMention(3, 0, 4),
    )
