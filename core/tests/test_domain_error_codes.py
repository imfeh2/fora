from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import Mock

import pytest

from fora.adapters.execution.manager import ExecutionManager, setting_directories
from fora.adapters.files.tree import DirectoryTree
from fora.adapters.model.history import decode_history, render_history
from fora.core.attachment import (
    MAX_FILE_BYTES,
    MAX_FILES,
    Attachment,
    identifier,
    validate_attachments,
    validate_upload,
)
from fora.core.discussion import MAX_BODY_LENGTH, validate_body, validate_topic
from fora.core.errors import DomainError
from fora.core.member import MAX_NAME_LENGTH, validate_name
from fora.services.history import History
from fora.services.library import Library
from fora.services.workspace import Workspace


@contextmanager
def domain_error(code: str):
    with pytest.raises(DomainError) as failure:
        yield
    assert failure.value.code == code


def attachment(index: int, size: int = 1, media_type: str = "text/plain") -> Attachment:
    return Attachment(
        id=f"00000000-0000-4000-8000-{index:012d}",
        name=f"file{index}.txt",
        size=size,
        media_type=media_type,
        sha256="0" * 64,
    )


@pytest.mark.parametrize(
    "value",
    [None, 17, "", "   ", "a@b", "a" * (MAX_NAME_LENGTH + 1)],
)
def test_member_name_violations_report_invalid_name(value) -> None:
    with domain_error("invalid_name"):
        validate_name(value)


def test_member_name_accepts_a_normal_name() -> None:
    assert validate_name("Ada Lovelace") == "Ada Lovelace"


@pytest.mark.parametrize("value", [None, 17, "", "  ", "t" * 4096])
def test_topic_violations_report_invalid_topic(value) -> None:
    with domain_error("invalid_topic"):
        validate_topic(value)


@pytest.mark.parametrize("value", [None, 17, "", "  ", "b" * (MAX_BODY_LENGTH + 1)])
def test_body_violations_report_invalid_body(value) -> None:
    with domain_error("invalid_body"):
        validate_body(value)


def test_empty_body_is_allowed_with_attachments() -> None:
    assert validate_body("", has_attachments=True) == ""


@pytest.mark.parametrize(
    "value", [None, "", "not-a-uuid", "00000000000040008000000000000000"]
)
def test_invalid_attachment_identifiers_report_invalid_id(value) -> None:
    with domain_error("invalid_id"):
        identifier(value)


@pytest.mark.parametrize(
    ("name", "size", "media_type", "code"),
    [
        ("", 1, "text/plain", "invalid_filename"),
        (None, 1, "text/plain", "invalid_filename"),
        ("a/b.txt", 1, "text/plain", "invalid_filename"),
        ("file.txt", MAX_FILE_BYTES + 1, "text/plain", "file_too_large"),
        ("file.txt", "1", "text/plain", "file_too_large"),
        ("file.txt", 1, None, "invalid_media_type"),
        ("file.png", 6 * 1024 * 1024, "image/png", "image_too_large"),
    ],
)
def test_upload_violations_report_their_code(name, size, media_type, code) -> None:
    with domain_error(code):
        validate_upload(name, size, media_type)


def test_attachment_limits_report_their_code() -> None:
    with domain_error("too_many_files"):
        validate_attachments(tuple(attachment(index) for index in range(MAX_FILES + 1)))
    with domain_error("attachments_too_large"):
        validate_attachments(
            tuple(attachment(index, size=15 * 1024 * 1024) for index in range(4))
        )


def test_file_tree_reports_missing_unreadable_and_invalid_paths(tmp_path) -> None:
    tree = DirectoryTree(tmp_path)
    (tmp_path / "binary.bin").write_bytes(b"\xff\xfe")
    with domain_error("not_found"):
        tree.read("missing.md")
    with domain_error("not_readable"):
        tree.read("binary.bin")
    for path in ("../outside.md", "/etc/hosts", "."):
        with domain_error("invalid_path"):
            tree.read(path)


def test_file_tree_reports_non_string_content(tmp_path) -> None:
    tree = DirectoryTree(tmp_path)
    with domain_error("invalid_content"):
        tree.write("notes.md", b"bytes")


def test_file_tree_requires_a_hash_before_overwriting(tmp_path) -> None:
    tree = DirectoryTree(tmp_path)
    tree.write("notes.md", "first")
    with domain_error("expected_hash_required"):
        tree.write("notes.md", "second")


def test_file_tree_reports_a_stale_hash_as_a_content_change(tmp_path) -> None:
    tree = DirectoryTree(tmp_path)
    tree.write("notes.md", "first")
    with domain_error("content_changed"):
        tree.write("notes.md", "second", expected_hash="stale")


def test_file_tree_reports_missing_moves_and_existing_targets(tmp_path) -> None:
    tree = DirectoryTree(tmp_path)
    tree.write("a.md", "a")
    tree.write("b.md", "b")
    with domain_error("not_found"):
        tree.move("missing.md", "c.md")
    with domain_error("already_exists"):
        tree.move("a.md", "b.md")


def test_library_and_workspace_report_the_same_read_codes(tmp_path) -> None:
    tree = DirectoryTree(tmp_path)
    (tmp_path / "binary.bin").write_bytes(b"\xff\xfe")
    for service in (Library(tree), Workspace(tree)):
        with domain_error("not_found"):
            service.read("missing.md")
    with domain_error("not_readable"):
        Library(tree).read("binary.bin")


def test_history_rejects_invalid_offsets() -> None:
    history = History(Mock(), 1)
    for offset in (-1, True, 2**63):
        with domain_error("invalid_offset"):
            history.read(1, offset)


def test_history_reports_invalid_stored_history() -> None:
    with domain_error("history_invalid"):
        decode_history("{not json}")
    with domain_error("invalid_offset"):
        render_history("[]", source="test", offset=1)


def test_execution_settings_report_their_code() -> None:
    with domain_error("invalid_directory"):
        setting_directories("not-a-list")
    manager = ExecutionManager(settings={"unknown": 1}, tolerant=True)
    with domain_error("invalid_setting"):
        manager.configure({"unknown": 2}, lambda values: None)
