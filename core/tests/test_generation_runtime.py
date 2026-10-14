from __future__ import annotations

import asyncio
import json
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.ports.agent import GenerationUpdate, ModelRequestHandle, SendPreviewCandidate
from fora.runtime.reminder import HistoryPersistenceError
from fora.runtime.scheduler import _TurnRequestRecorder


@pytest.fixture
def records(tmp_path: Path):
    organization = SqliteStore(tmp_path / "generation-runtime.sqlite")
    human = organization.create_member("human", "You")
    agent = organization.create_member("agent", "Writer")
    first = organization.create_discussion("First", [human.id, agent.id])
    second = organization.create_discussion("Second", [human.id, agent.id])
    history = SqliteAgentStore(organization._db)
    run = history.start_run(agent.id)
    events = []
    recorder = _TurnRequestRecorder(
        history,
        run,
        1,
        lambda phase: None,
        lambda name, value: events.append((name, value)),
    )
    handle = recorder.start((), "{}", "{}", "{}", True)
    yield (
        organization,
        history,
        run,
        recorder,
        handle,
        events,
        human.id,
        first.id,
        second.id,
    )
    organization.close()


def snapshot(body: str, discussion_id: int | None = None) -> GenerationUpdate:
    return GenerationUpdate(
        "text" if discussion_id is None else "tool-call",
        json.dumps({"part_kind": "text", "content": body}),
        preview=SendPreviewCandidate(discussion_id, body)
        if discussion_id is not None
        else None,
    )


def test_request_identity_must_be_persisted_before_content(records):
    _organization, history, run, recorder, handle, events, _human, _first, _second = (
        records
    )
    with pytest.raises(ValueError, match="not recorded"):
        recorder.generation(
            ModelRequestHandle(handle.ordinal, "different"), 0, snapshot("x")
        )
    with pytest.raises(ValueError, match="part index"):
        recorder.generation(handle, True, snapshot("x"))
    assert history.generation.parts(run.agent_id, run.sequence, handle.ordinal) == ()
    assert events == []


def test_continuous_updates_are_coalesced_in_a_fifty_millisecond_cycle(
    records, monkeypatch
):
    _organization, history, _run, recorder, handle, events, _human, first, _second = (
        records
    )
    save = history.generation.save
    saved = []

    def capture(key, update):
        saved.append(update)
        return save(key, update)

    monkeypatch.setattr(history.generation, "save", capture)

    async def run():
        ready = asyncio.Queue()
        delays = []
        original_sleep = asyncio.sleep

        async def sleep(delay):
            delays.append(delay)
            await original_sleep(delay)

        monkeypatch.setattr(asyncio, "sleep", sleep)
        recorder._generation._notify = lambda name, payload: (
            (events.append((name, payload)), ready.put_nowait(payload))
            if name == "turn.generation"
            else None
        )
        async with recorder.generation_session():
            recorder.generation(handle, 0, snapshot("first", first))
            await ready.get()
            for index in range(50):
                recorder.generation(handle, 0, snapshot(f"received {index}", first))
            assert len(saved) == 1
            update = await asyncio.wait_for(ready.get(), 2)
            assert update["revision"] == 2
            key = recorder.generation_key(handle, 0)
            page = history.generation.part_text(key, 2, field="content")
            assert page.value == "received 49"
            assert [item.preview.body for item in saved] == ["first", "received 49"]
            assert delays == [0.05]
        assert recorder._generation._event is None

    asyncio.run(run())


def test_target_changes_notify_both_discussions_after_the_saved_revision(records):
    _organization, history, _run, recorder, handle, events, human, first, second = (
        records
    )
    recorder.generation(handle, 0, snapshot("first", first))
    events.clear()
    recorder.generation(handle, 0, snapshot("second", second))
    recorder._generation.flush()
    preview = history.generation.preview(recorder.generation_key(handle, 0))
    assert preview is not None
    assert history.generation.previews(first, human) == ()
    notices = [payload for name, payload in events if name == "discussion.preview"]
    assert notices == [
        {"discussion_id": first, "preview_id": preview.preview_id, "revision": 2},
        {"discussion_id": second, "preview_id": preview.preview_id, "revision": 2},
    ]
    assert all(
        "body" not in payload and "error" not in payload for _name, payload in events
    )


def test_response_synchronously_saves_the_last_batch_and_completes_each_part(records):
    _organization, history, _run, recorder, handle, events, _human, first, _second = (
        records
    )
    recorder.generation(handle, 0, snapshot("first", first))
    recorder.generation(handle, 0, snapshot("final", first))
    recorder.generation(handle, 1, snapshot("reasoning"))
    recorder.generation(handle, 1, snapshot("final reasoning"))
    before = len(events)
    recorder.response(handle, ())
    for index, text in ((0, "final"), (1, "final reasoning")):
        key = recorder.generation_key(handle, index)
        part = history.generation.part(key)
        assert part.status == "completed"
        assert (
            history.generation.part_text(key, part.revision, field="content").value
            == text
        )
    assert len(events) > before
    assert (
        history.generation.preview(recorder.generation_key(handle, 0)).status
        == "sending"
    )


def test_failure_saves_the_last_snapshot_without_publishing_reason_or_creating_messages(
    records,
):
    organization, history, _run, recorder, handle, events, human, first, _second = (
        records
    )
    recorder.generation(handle, 0, snapshot("first", first))
    recorder.generation(handle, 0, snapshot("received", first))
    recorder.error(handle, "Provider failed")
    key = recorder.generation_key(handle, 0)
    part = history.generation.part(key)
    preview = history.generation.preview(key)
    assert part.status == preview.status == "failed"
    assert part.error == preview.error == "Provider failed"
    assert (
        history.generation.part_text(key, part.revision, field="content").value
        == "received"
    )
    assert (
        history.generation.preview_text(
            preview.preview_id, first, human, preview.revision
        ).value
        == "received"
    )
    assert organization.message_count(first) == 0
    assert organization.pending(human) == ()
    assert "Provider failed" not in json.dumps(events)
    recorder.generation(handle, 0, snapshot("late", first))
    assert history.generation.part(key) == part


def test_success_without_formal_submission_keeps_a_failed_readable_preview(records):
    _organization, history, _run, recorder, handle, _events, human, first, _second = (
        records
    )
    recorder.generation(handle, 0, snapshot("received", first))
    recorder.response(handle, ('[{"kind":"response","parts":[]}]',))
    recorder.success(handle)
    key = recorder.generation_key(handle, 0)
    preview = history.generation.preview(key)
    assert preview.status == "failed"
    assert preview.error == "The request ended without a confirmed send"
    assert (
        history.generation.preview_text(
            preview.preview_id, first, human, preview.revision
        ).value
        == "received"
    )


def test_confirmed_submission_takes_priority_over_a_later_request_failure(records):
    organization, history, run, recorder, handle, _events, _human, first, _second = (
        records
    )
    recorder.generation(handle, 0, snapshot("@You received", first))
    recorder.response(handle, ())
    key = recorder.generation_key(handle, 0)
    message, _mentions, _created = organization.submit_message(
        first, run.agent_id, "@You final", generation_key=key
    )
    sent = history.generation.preview(key)
    recorder.error(handle, "Lost receipt")
    assert history.generation.preview(key) == sent
    assert sent.status == "sent" and sent.message_id == message.id
    assert history.generation.part(key).status == "completed"


def test_new_requests_and_parallel_parts_keep_independent_buffers(records):
    _organization, history, run, recorder, handle, _events, _human, first, _second = (
        records
    )
    second = recorder.start((), "{}", "{}", "{}", True)
    recorder.generation(handle, 0, snapshot("first", first))
    recorder.generation(second, 0, snapshot("second", first))
    recorder.generation(handle, 0, snapshot("first final", first))
    recorder.generation(second, 0, snapshot("second final", first))
    recorder.error(handle, "First request failed")
    other = recorder.generation_key(second, 0)
    assert history.generation.part(other).revision == 1
    assert history.generation.part(other).status == "generating"
    recorder.close("Turn failed")
    assert history.generation.part(other).status == "failed"
    assert (
        history.generation.part_text(other, 2, field="content").value == "second final"
    )
    assert len(history.model_request_summaries(run.agent_id, run.sequence)) == 2


def test_final_part_rejects_late_updates_without_additional_writes(records):
    _organization, history, _run, recorder, handle, events, _human, first, _second = (
        records
    )
    recorder.generation(handle, 0, snapshot("first", first))
    final = replace(snapshot("final", first), status="completed")
    recorder.generation(handle, 0, final)
    key = recorder.generation_key(handle, 0)
    saved = history.generation.part(key)
    before = len(events)
    recorder.generation(handle, 0, snapshot("late", first))
    assert history.generation.part(key) == saved
    assert len(events) == before


def test_persistence_failure_terminates_the_active_session_and_preserves_committed_content(
    records, monkeypatch
):
    _organization, history, _run, recorder, handle, events, _human, first, _second = (
        records
    )
    recorder.generation(handle, 0, snapshot("committed", first))
    key = recorder.generation_key(handle, 0)
    before = tuple(events)

    def fail(key, update):
        raise sqlite3.OperationalError("Storage unavailable")

    monkeypatch.setattr(history.generation, "save", fail)

    async def run():
        with pytest.raises(HistoryPersistenceError, match="save generation"):
            async with recorder.generation_session():
                recorder.generation(handle, 0, snapshot("pending", first))
                await asyncio.sleep(2)
        assert recorder._generation._event is None
        assert tuple(events) == before
        assert (
            history.generation.part_text(key, 1, field="content").value == "committed"
        )

    asyncio.run(run())


@pytest.mark.parametrize("cancelled", [False, True])
def test_session_preserves_the_original_request_error_and_releases_its_pump(
    records, cancelled
):
    (
        _organization,
        _history,
        _run,
        recorder,
        _handle,
        _events,
        _human,
        _first,
        _second,
    ) = records
    error = (
        asyncio.CancelledError("Request cancelled")
        if cancelled
        else RuntimeError("Request failed")
    )

    async def run():
        before = asyncio.all_tasks()
        with pytest.raises(type(error)) as captured:
            async with recorder.generation_session():
                raise error
        assert captured.value is error
        assert asyncio.all_tasks() == before
        assert recorder._generation._event is None

    asyncio.run(run())


def test_session_exit_cancels_its_pump_and_turn_close_saves_pending_content(records):
    _organization, history, _run, recorder, handle, _events, _human, _first, _second = (
        records
    )

    async def run():
        before = asyncio.all_tasks()
        async with recorder.generation_session():
            recorder.generation(handle, 0, snapshot("first"))
            recorder.generation(handle, 0, snapshot("last"))
        assert asyncio.all_tasks() == before
        recorder.close()
        key = recorder.generation_key(handle, 0)
        part = history.generation.part(key)
        assert part.status == "completed"
        assert (
            history.generation.part_text(key, part.revision, field="content").value
            == "last"
        )
        with pytest.raises(ValueError, match="unavailable"):
            async with recorder.generation_session():
                pytest.fail("Closed sessions cannot start")

    asyncio.run(run())
