from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.generation import initialize_generation, text_page
from fora.adapters.sqlite.store import SqliteStore
from fora.core.errors import DomainError
from fora.ports.agent import GenerationKey, GenerationUpdate, SendPreviewCandidate


@pytest.fixture
def records(tmp_path: Path):
    organization = SqliteStore(tmp_path / "generation.sqlite")
    human = organization.create_member("human", "You")
    agent = organization.create_member("agent", "Writer")
    other = organization.create_member("human", "Other")
    discussion = organization.create_discussion("First", [human.id, agent.id])
    second = organization.create_discussion("Second", [human.id, agent.id])
    history = SqliteAgentStore(organization._db)
    run = history.start_run(agent.id)
    request = history.start_model_request(
        agent.id, run.sequence, run.run_id, 1, (), "{}", "{}", "{}", True
    )
    key = GenerationKey(
        agent.id, run.sequence, request.ordinal, 0, request.request_id, run.run_id
    )
    yield (
        organization,
        history,
        human.id,
        agent.id,
        other.id,
        discussion.id,
        second.id,
        key,
    )
    organization.close()


def snapshot(
    discussion_id: int | None = None, body: str = "partial", status: str = "generating"
) -> GenerationUpdate:
    return GenerationUpdate(
        "tool-call" if discussion_id is not None else "text",
        json.dumps({"part_kind": "text", "content": body}),
        status=status,
        preview=SendPreviewCandidate(discussion_id, body)
        if discussion_id is not None
        else None,
    )


def test_creates_only_the_generation_tables_without_backfilling(records):
    organization, history, human, agent, _other, discussion, _second, key = records
    assert history.generation.parts(agent, key.sequence, key.ordinal) == ()
    assert history.generation.previews(discussion, human) == ()
    tables = {
        row["name"]
        for row in organization._db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }
    assert {"agent_generation_parts", "discussion_previews"} <= tables


def test_requires_complete_persistent_request_identity(records):
    _organization, history, _human, agent, _other, discussion, _second, key = records
    for invalid in (
        replace(key, request_id="different"),
        replace(key, run_id="different"),
        replace(key, ordinal=key.ordinal + 1),
    ):
        with pytest.raises(DomainError, match="identity"):
            history.generation.save(invalid, snapshot(discussion))
    assert history.generation.parts(agent, key.sequence, key.ordinal) == ()


def test_revisions_and_part_replacements_keep_identity_and_creation_time(records):
    _organization, history, _human, _agent, _other, discussion, _second, key = records
    first = history.generation.save(key, snapshot()).part
    next_part = history.generation.save(key, snapshot(discussion, "updated")).part
    assert next_part.key == first.key
    assert next_part.created_at == first.created_at
    assert next_part.revision == 2
    assert next_part.part_kind == "tool-call"
    assert history.generation.part_text(key, 2).value.endswith('"updated"}')
    with pytest.raises(DomainError, match="revision"):
        history.generation.part_text(key, 1)


def test_target_moves_atomically_and_body_revision_is_the_same(records):
    _organization, history, human, _agent, _other, discussion, second, key = records
    first = history.generation.save(key, snapshot(discussion, "first")).preview
    assert first is not None
    moved = history.generation.save(key, snapshot(second, "second"))
    assert moved.preview is not None
    assert moved.preview.preview_id == first.preview_id
    assert moved.preview.created_at == first.created_at
    assert moved.previous_discussion_id == discussion
    assert history.generation.previews(discussion, human) == ()
    assert (
        history.generation.preview_text(
            first.preview_id, second, human, moved.preview.revision
        ).value
        == "second"
    )
    with pytest.raises(DomainError, match="not visible"):
        history.generation.preview_text(
            first.preview_id, discussion, human, first.revision
        )


def test_sender_and_reader_membership_is_checked_on_every_read(records):
    organization, history, human, agent, other, discussion, _second, key = records
    preview = history.generation.save(key, snapshot(discussion)).preview
    assert preview is not None
    with pytest.raises(DomainError, match="belong"):
        history.generation.previews(discussion, other)
    organization.change_discussion_members(discussion, [agent], remove=True)
    assert history.generation.previews(discussion, human) == ()
    with pytest.raises(DomainError, match="not visible"):
        history.generation.preview_text(
            preview.preview_id, discussion, human, preview.revision
        )
    assert history.generation.part(key).revision == preview.revision


def test_target_retraction_keeps_agent_history_without_publishing_in_another_discussion(
    records,
):
    _organization, history, human, _agent, _other, discussion, second, key = records
    first = history.generation.save(key, snapshot(discussion)).preview
    assert first is not None
    retracted = history.generation.save(key, snapshot())
    assert retracted.preview is not None
    assert retracted.preview.discussion_id is None
    assert history.generation.previews(discussion, human) == ()
    assert history.generation.previews(second, human) == ()
    assert history.generation.part_text(key, retracted.part.revision).value


@pytest.mark.parametrize("status", ["failed", "interrupted"])
def test_failed_and_interrupted_previews_keep_the_last_authorized_body(records, status):
    _organization, history, human, _agent, _other, discussion, second, key = records
    original = history.generation.save(key, snapshot(discussion, "received"))
    failed = history.generation.save(
        key, GenerationUpdate("tool-call", "{}", status=status, error="Model stopped")
    )
    assert failed.preview is not None
    assert failed.preview.status == status
    assert failed.preview.error == "Model stopped"
    assert (
        history.generation.preview_text(
            failed.preview.preview_id, discussion, human, failed.preview.revision
        ).value
        == "received"
    )
    late = history.generation.save(key, snapshot(second, "late"))
    assert late.part.revision == failed.part.revision
    assert late.preview == failed.preview
    assert original.preview is not None
    assert late.preview.preview_id == original.preview.preview_id


def test_parameter_error_on_a_replacement_part_retracts_the_previous_position(records):
    _organization, history, human, _agent, _other, discussion, _second, key = records
    original = history.generation.save(key, snapshot(discussion, "Received")).preview
    replaced = history.generation.save(
        key,
        GenerationUpdate(
            "tool-call",
            "{}",
            preview_error="Tool parameters contain invalid JSON",
            replace_part=True,
        ),
    ).preview
    assert replaced is not None and original is not None
    assert replaced.preview_id == original.preview_id
    assert replaced.discussion_id is None
    assert replaced.status == "failed"
    assert history.generation.previews(discussion, human) == ()


def test_generated_content_does_not_create_messages_mentions_or_watermarks(records):
    organization, history, human, _agent, _other, discussion, _second, key = records
    history.generation.save(key, snapshot(discussion, "@You generated"))
    assert organization.message_count(discussion) == 0
    assert organization.pending(human) == ()
    assert organization.watermark(discussion, human) == 0


def test_message_mapping_and_generation_changes_share_the_original_transaction(records):
    organization, history, human, agent, _other, discussion, _second, key = records
    original = history.generation.save(key, snapshot(discussion, "@You preview"))
    with pytest.raises(RuntimeError, match="after link"), organization._db:
        message, _, _ = organization.submit_message(discussion, agent, "@You final")
        history.generation.link(key, message)
        raise RuntimeError("after link")
    assert organization.message_count(discussion) == 0
    assert history.generation.preview(key) == original.preview
    with organization._db:
        message, mentions, created = organization.submit_message(
            discussion, agent, "@You final"
        )
        linked = history.generation.link(key, message)
    assert created and len(mentions) == 1
    assert linked.status == "sent" and linked.message_id == message.id
    assert history.generation.link(key, message) == linked
    assert history.generation.previews(discussion, human) == ()
    assert (
        history.generation.visible_preview(
            linked.preview_id, discussion, human
        ).message_id
        == message.id
    )
    later = history.generation.save(
        key, GenerationUpdate("tool-call", "{}", status="failed", error="Lost receipt")
    )
    assert later.preview is not None and later.preview.status == "sent"


def test_body_and_part_changes_roll_back_together(records):
    _organization, history, _human, _agent, _other, discussion, _second, key = records
    original = history.generation.save(key, snapshot(discussion))
    with pytest.raises(DomainError, match="candidate"):
        history.generation.save(
            key, replace(snapshot(), preview=SendPreviewCandidate(-1, "invalid"))
        )
    assert history.generation.part(key) == original.part
    assert history.generation.preview(key) == original.preview


def test_parallel_parts_and_retry_requests_are_independent(records):
    _organization, history, human, agent, _other, discussion, _second, key = records
    first = history.generation.save(key, snapshot(discussion)).preview
    another = history.generation.save(
        replace(key, part_index=1), snapshot(discussion)
    ).preview
    retry = history.start_model_request(
        agent, key.sequence, key.run_id, 1, (), "{}", "{}", "{}", True
    )
    retry_key = replace(key, ordinal=retry.ordinal, request_id=retry.request_id)
    third = history.generation.save(retry_key, snapshot(discussion)).preview
    assert first and another and third
    assert len({first.preview_id, another.preview_id, third.preview_id}) == 3
    assert len(history.generation.previews(discussion, human)) == 3


def test_preview_and_part_lists_have_stable_exclusive_bounds(records):
    _organization, history, human, agent, _other, discussion, _second, key = records
    for index in range(4):
        history.generation.save(
            replace(key, part_index=index), snapshot(discussion, str(index))
        )
    page = history.generation.previews(discussion, human, limit=2)
    more = history.generation.previews(
        discussion, human, limit=2, before=(page[-1].created_at, page[-1].preview_id)
    )
    assert len(page) == len(more) == 2
    assert not {item.preview_id for item in page} & {item.preview_id for item in more}
    assert [
        item.key.part_index
        for item in history.generation.parts(
            agent, key.sequence, key.ordinal, after=1, limit=2
        )
    ] == [2, 3]


def test_restart_interrupts_unfinished_records_and_keeps_sent_mappings(records):
    organization, history, _human, agent, _other, discussion, _second, key = records
    history.generation.save(key, snapshot(discussion))
    finished_key = replace(key, part_index=1)
    history.generation.save(finished_key, snapshot(discussion))
    with organization._db:
        message, _, _ = organization.submit_message(discussion, agent, "@You completed")
        sent = history.generation.link(finished_key, message)
    assert history.generation.interrupt() == 2
    assert history.generation.preview(key).status == "interrupted"
    assert history.generation.preview(finished_key) == sent
    assert history.generation.interrupt() == 0


@pytest.mark.parametrize(
    "offset,limit,expected,next_offset",
    [(0, 3, "中", 3), (3, 4, "😀", 7), (7, 2, "文", 10), (10, 8, "", 10)],
)
def test_utf8_page_boundaries(offset, limit, expected, next_offset):
    if offset == 7 and limit == 2:
        with pytest.raises(DomainError, match="complete character"):
            text_page("中😀文".encode()[offset : offset + limit], 10, 1, offset, limit)
    else:
        result = text_page(
            "中😀文".encode()[offset : offset + limit], 10, 1, offset, limit
        )
        assert result.value == expected
        assert result.next_offset == next_offset


@pytest.mark.parametrize(
    "offset,limit", [(1, 5), (-1, 3), (True, 3), (0, False), (0, 0), (11, 3)]
)
def test_invalid_utf8_page_bounds(offset, limit):
    with pytest.raises(DomainError):
        text_page("中😀文".encode()[offset : offset + limit], 10, 1, offset, limit)


def test_long_text_reads_are_bounded_in_sql_and_pages_keep_unicode(
    records, monkeypatch
):
    organization, history, human, _agent, _other, discussion, _second, key = records
    body = "中😀文" * 10000
    update = history.generation.save(key, snapshot(discussion, body))
    assert update.preview is not None
    execute = organization._db.execute
    fetched = []

    def capture(sql, parameters=()):
        rows = execute(sql, parameters)
        for row in rows:
            if "content" in tuple(row.keys()):
                fetched.append(row["content"])
        return rows

    monkeypatch.setattr(organization._db, "execute", capture)
    page = history.generation.preview_text(
        update.preview.preview_id, discussion, human, update.preview.revision, 0, 18
    )
    assert page.value == "中😀文中😀"
    assert page.next_offset == 17
    assert page.total_bytes == 100000
    assert page.has_more
    continuation = history.generation.preview_text(
        update.preview.preview_id, discussion, human, page.revision, page.next_offset, 8
    )
    assert continuation.value == "文中"
    assert continuation.next_offset == 23
    part = history.generation.part_text(key, update.part.revision, 0, 19)
    assert part.total_bytes > 100000
    assert len(fetched) == 3
    assert all(len(content) <= 19 for content in fetched)
    with pytest.raises(DomainError, match="revision"):
        history.generation.preview_text(
            update.preview.preview_id, discussion, human, True
        )
    with pytest.raises(DomainError, match="UTF-8 boundary"):
        history.generation.preview_text(
            update.preview.preview_id, discussion, human, page.revision, 1, 8
        )
    history.generation.save(key, snapshot(discussion, "replaced"))
    with pytest.raises(DomainError, match="revision changed"):
        history.generation.preview_text(
            update.preview.preview_id,
            discussion,
            human,
            page.revision,
            page.next_offset,
            8,
        )


def test_completed_part_does_not_resume_on_late_delta(records):
    _organization, history, _human, _agent, _other, discussion, _second, key = records
    completed = history.generation.save(key, snapshot(discussion, "Final", "completed"))
    late = history.generation.save(key, snapshot(discussion, "Late"))
    assert late.part == completed.part
    assert late.preview == completed.preview


def test_closed_request_rejects_new_generating_parts(records):
    _organization, history, _human, _agent, _other, discussion, _second, key = records
    history.mark_interrupted()
    with pytest.raises(DomainError, match="already closed"):
        history.generation.save(key, snapshot(discussion))


def test_generation_schema_creation_is_atomic(records, monkeypatch):
    organization, _history, _human, _agent, _other, _discussion, _second, _key = records
    organization._db.execute("DROP TABLE discussion_previews")
    organization._db.execute("DROP TABLE agent_generation_parts")
    execute = organization._db.execute

    def fail_second(sql, parameters=()):
        if "CREATE TABLE IF NOT EXISTS discussion_previews" in sql:
            raise sqlite3.OperationalError("schema failure")
        return execute(sql, parameters)

    monkeypatch.setattr(organization._db, "execute", fail_second)
    with pytest.raises(sqlite3.OperationalError, match="schema failure"):
        initialize_generation(organization._db)
    monkeypatch.setattr(organization._db, "execute", execute)
    assert not execute(
        "SELECT 1 FROM sqlite_master WHERE name IN ('agent_generation_parts', 'discussion_previews')"
    )
