from __future__ import annotations

from pathlib import Path

import pytest

from fora.adapters.execution.editing import edit_file
from fora.adapters.files.tree import DirectoryTree
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError


def test_editing_with_the_text_just_read_writes_lf(tmp_path: Path) -> None:
    tree = DirectoryTree(tmp_path)
    (tmp_path / "doc.md").write_bytes(b"first\r\nsecond line\r\nthird\r\n")

    content, _ = tree.read("doc.md")
    tree.edit("doc.md", content, content.replace("second line", "changed line"))

    raw = (tmp_path / "doc.md").read_bytes()
    assert raw == b"first\nchanged line\nthird\n"
    assert b"\r" not in raw


def test_new_text_with_crlf_is_written_as_lf(tmp_path: Path) -> None:
    tree = DirectoryTree(tmp_path)
    (tmp_path / "doc.md").write_bytes(b"alpha\nbeta\n")

    tree.edit("doc.md", "beta", "beta\r\ngamma")

    assert (tmp_path / "doc.md").read_bytes() == b"alpha\nbeta\ngamma\n"


def test_creating_with_crlf_writes_lf(tmp_path: Path) -> None:
    edit_file(
        str(tmp_path / "new.md"),
        [{"old_text": "", "new_text": "one\r\ntwo\r\n"}],
        directories=[str(tmp_path)],
        create=True,
    )

    assert (tmp_path / "new.md").read_bytes() == b"one\ntwo\n"


def test_editing_a_non_utf8_document_still_reports_not_readable(tmp_path: Path) -> None:
    tree = DirectoryTree(tmp_path)
    (tmp_path / "doc.md").write_bytes(b"\xff\xfe bad \r\n")

    with pytest.raises(DomainError) as error:
        tree.edit("doc.md", "bad", "good")

    assert error.value.code == ErrorCode.NOT_READABLE


def test_editing_a_non_utf8_file_without_a_tree_still_reports_not_text(
    tmp_path: Path,
) -> None:
    target = tmp_path / "doc.md"
    target.write_bytes(b"\xff\xfe bad \r\n")

    with pytest.raises(DomainError) as error:
        edit_file(
            str(target),
            [{"old_text": "bad", "new_text": "good"}],
            directories=[str(tmp_path)],
        )

    assert error.value.code == ErrorCode.NOT_TEXT
