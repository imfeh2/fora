from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, Event
from uuid import uuid4

import pytest

from fora.adapters.files.uploads import DirectoryUploads
from fora.adapters.sqlite.store import SqliteStore
from fora.core.errors import DomainError
from fora.services.uploads import Uploads


@pytest.fixture
def world(tmp_path: Path):
    store = SqliteStore(tmp_path / "fora.sqlite3")
    human = store.create_member("human", "You")
    sender = store.create_member("agent", "Sender")
    reader = store.create_member("agent", "Review Team")
    outsider = store.create_member("agent", "Outside")
    deleted = store.create_member("agent", "Deleted")
    room = store.create_discussion("Work", [human.id, sender.id, reader.id, deleted.id])
    store.delete_member(deleted.id)
    yield store, human, sender, reader, outsider, room
    store.close()


@pytest.mark.parametrize("method", ["submit_message", "append_message"])
@pytest.mark.parametrize(
    "body",
    [
        "Update",
        "You",
        "@Unknown",
        "@Sender",
        "@Outside",
        "@Deleted",
        "@Younger",
        "mail@You",
        "@Review Teams",
    ],
)
def test_agent_requires_effective_recipient(world, method, body) -> None:
    store, human, sender, reader, _outsider, room = world
    with pytest.raises(DomainError) as error:
        getattr(store, method)(room.id, sender.id, body)
    assert error.value.code == "mention_required"
    assert str(error.value) == "Mention at least one other member of this discussion."
    assert store.message_count(room.id) == 0
    assert store.pending(human.id) == store.pending(reader.id) == ()


@pytest.mark.parametrize(
    ("body", "recipients"),
    [
        ("@You", [1]),
        ("@review team", [3]),
        ("@Sender @Unknown @Outside @You @You", [1]),
        ("(@Review Team), @You", [3, 1]),
    ],
)
def test_agent_persists_final_mentions_once(world, body, recipients) -> None:
    store, _human, sender, _reader, outsider, room = world
    message, mentions, created = store.submit_message(room.id, sender.id, body)
    assert created and message.id == 1
    assert [item.member_id for item in mentions] == recipients
    assert [
        item.member_id for item in store.messages(room.id)[0].mentions
    ] == recipients
    assert store.pending(sender.id) == ()
    assert store.pending(outsider.id) == ()


@pytest.mark.parametrize("method", ["submit_message", "append_message"])
@pytest.mark.parametrize("recipients", ["none", "removed", "deleted"])
def test_agent_without_other_active_discussion_members_is_rejected(
    world, method, recipients
) -> None:
    store, _human, sender, reader, _outsider, _room = world
    member_ids = [sender.id] if recipients == "none" else [sender.id, reader.id]
    room = store.create_discussion("No recipients", member_ids)
    if recipients == "removed":
        store.change_discussion_members(room.id, [reader.id], remove=True)
    elif recipients == "deleted":
        store.delete_member(reader.id)
    before = snapshot(store)
    with pytest.raises(DomainError) as error:
        getattr(store, method)(room.id, sender.id, "@Review Team @Sender @You")
    assert error.value.code == "mention_required"
    assert snapshot(store) == before
    assert store.message_count(room.id) == 0


def snapshot(store):
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


def test_rejection_preserves_ready_attachment_and_all_persistent_state(
    world, tmp_path
) -> None:
    store, human, sender, _reader, _outsider, room = world
    store.append_message(room.id, human.id, "@Sender work")
    uploads = Uploads(store, DirectoryUploads(tmp_path / "uploads"))
    data = b"review attachment"
    upload = uploads.create(
        room.id, sender.id, str(uuid4()), "review.txt", len(data), "text/plain"
    )
    active, target = uploads.begin(upload.id, sender.id)
    with target:
        target.write(data)
    attachment = uploads.complete(active)
    uploads.end(active)
    receipt = str(uuid4())
    before = snapshot(store)
    for body in ("Review ready", "@Sender"):
        with pytest.raises(DomainError) as error:
            store.submit_message(
                room.id,
                sender.id,
                body,
                attachment_ids=[upload.id],
                client_message_id=receipt,
                mark_read=True,
            )
        assert error.value.code == "mention_required"
        assert snapshot(store) == before
        with uploads.files.reader(attachment) as source:
            assert source.read() == data
        assert store.send_outcome(room.id, sender.id, receipt) == ("unknown", None)
    message, mentions, created = store.submit_message(
        room.id,
        sender.id,
        "@You review ready",
        attachment_ids=[upload.id],
        client_message_id=receipt,
        mark_read=True,
    )
    assert created and message.id == 2
    assert [item.member_id for item in mentions] == [human.id]
    assert message.attachments == (attachment,)
    assert store.watermark(room.id, sender.id) == 2
    assert store.get_upload(upload.id, sender.id).state == "attached"


@pytest.mark.parametrize("change", ["rename", "remove", "delete"])
def test_successful_receipt_replay_uses_original_message(world, change) -> None:
    store, _human, sender, reader, _outsider, room = world
    receipt = str(uuid4())
    message, _, _ = store.submit_message(
        room.id,
        sender.id,
        "@Review Team review",
        client_message_id=receipt,
        mark_read=True,
    )
    mutate(store, room.id, reader.id, change)
    before = snapshot(store)
    repeated, mentions, created = store.submit_message(
        room.id, sender.id, message.body, client_message_id=receipt, mark_read=True
    )
    assert repeated == message and not created and mentions == ()
    assert snapshot(store) == before
    with pytest.raises(DomainError) as error:
        store.submit_message(room.id, sender.id, "Changed", client_message_id=receipt)
    assert error.value.code == "message_conflict"
    with pytest.raises(DomainError) as error:
        store.submit_message(
            room.id,
            sender.id,
            message.body,
            attachment_ids=[str(uuid4())],
            client_message_id=receipt,
        )
    assert error.value.code == "message_conflict"
    cancelled = str(uuid4())
    store.cancel_send(room.id, sender.id, cancelled)
    with pytest.raises(DomainError) as error:
        store.submit_message(
            room.id, sender.id, "No mention", client_message_id=cancelled
        )
    assert error.value.code == "send_cancelled"


def test_legacy_agent_message_receipt_remains_readable(world) -> None:
    store, _human, sender, _reader, _outsider, room = world
    receipt = str(uuid4())
    with store._write() as db:
        db.execute(
            "INSERT INTO messages(discussion_id, id, sender_id, sender_name, body, created_at) VALUES (?, 1, ?, ?, 'Legacy update', '2026-09-01T00:00:00Z')",
            (room.id, sender.id, sender.name),
        )
        db.execute(
            "INSERT INTO message_receipts(discussion_id, owner_id, client_message_id, message_id) VALUES (?, ?, ?, 1)",
            (room.id, sender.id, receipt),
        )
    before = snapshot(store)
    message, mentions, created = store.submit_message(
        room.id, sender.id, "Legacy update", client_message_id=receipt, mark_read=True
    )
    assert message.id == 1 and message.mentions == mentions == () and not created
    assert snapshot(store) == before
    with pytest.raises(DomainError) as error:
        store.submit_message(
            room.id, sender.id, message.body, client_message_id=str(uuid4())
        )
    assert error.value.code == "mention_required"


def mutate(store, room_id, member_id, change):
    if change == "rename":
        store.rename_member(member_id, "Renamed")
    elif change == "remove":
        room = store.get_discussion(room_id)
        store.set_discussion_members(
            room_id, [item for item in room.member_ids if item != member_id]
        )
    else:
        store.delete_member(member_id)


@pytest.mark.parametrize("change", ["rename", "remove", "delete"])
@pytest.mark.parametrize("send_first", [False, True])
def test_two_connections_order_member_changes_and_send(
    world, change, send_first, tmp_path
) -> None:
    store, _human, sender, reader, _outsider, room = world
    other = SqliteStore(tmp_path / "fora.sqlite3")
    entered = Event()
    started = Event()
    release = Event()
    receipt = str(uuid4())

    def send(connection):
        try:
            return connection.submit_message(
                room.id,
                sender.id,
                "@Review Team review",
                client_message_id=receipt,
                mark_read=True,
            )
        except DomainError as error:
            assert error.code == "mention_required"
            return None

    def first():
        with store._write():
            result = (
                send(store) if send_first else mutate(store, room.id, reader.id, change)
            )
            entered.set()
            assert release.wait(10)
            return result

    def second():
        started.set()
        return mutate(other, room.id, reader.id, change) if send_first else send(other)

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first_future = pool.submit(first)
            try:
                assert entered.wait(10)
                second_future = pool.submit(second)
                assert started.wait(10)
            finally:
                release.set()
            first_result = first_future.result(timeout=10)
            second_result = second_future.result(timeout=10)
        result = first_result if send_first else second_result
        assert store.message_count(room.id) == int(send_first)
        assert store.watermark(room.id, sender.id) == int(send_first)
        assert store.send_outcome(room.id, sender.id, receipt)[0] == (
            "sent" if send_first else "unknown"
        )
        if send_first:
            assert result[2]
            assert [item.member_id for item in store.messages(room.id)[0].mentions] == [
                reader.id
            ]
        else:
            assert result is None
            assert store.mentions_by_message(room.id) == {}
    finally:
        release.set()
        other.close()


def test_two_connections_share_one_successful_agent_receipt(world, tmp_path) -> None:
    store, human, sender, _reader, _outsider, room = world
    other = SqliteStore(tmp_path / "fora.sqlite3")
    receipt = str(uuid4())
    barrier = Barrier(2)

    def send(connection):
        barrier.wait(timeout=10)
        return connection.submit_message(
            room.id,
            sender.id,
            "@You review",
            client_message_id=receipt,
            mark_read=True,
        )

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(send, connection) for connection in (store, other)]
            results = [future.result(timeout=10) for future in futures]
        assert sorted(result[2] for result in results) == [False, True]
        assert results[0][0] == results[1][0]
        assert store.message_count(room.id) == 1
        assert len(store.pending(human.id)) == 1
        assert store.watermark(room.id, sender.id) == 1
    finally:
        other.close()


def test_human_without_mentions_uses_existing_send_behavior(world) -> None:
    store, human, _sender, _reader, _outsider, room = world
    message, mentions, created = store.submit_message(
        room.id, human.id, "Update", mark_read=True
    )
    assert created and message.id == 1 and mentions == ()
    assert store.watermark(room.id, human.id) == 1
