from collections.abc import Iterator
from pathlib import Path

import pytest

from fora.adapters.sqlite.store import (
    UPLOAD_COUNT,
    UPLOAD_OWNER_BYTES,
    UPLOAD_TOTAL_BYTES,
    SqliteStore,
)
from fora.core.attachment import MAX_FILES, MAX_MESSAGE_BYTES, MIB
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError

PLAIN = "application/octet-stream"


@pytest.fixture()
def pool(tmp_path: Path) -> Iterator[tuple[SqliteStore, int, int]]:
    store = SqliteStore(tmp_path / "fora.sqlite3")
    member = store.create_member("human", "You")
    discussion = store.create_discussion("Uploads", [member.id])
    try:
        yield store, discussion.id, member.id
    finally:
        store.close()


def reserve(
    store: SqliteStore, discussion_id: int, owner_id: int, index: int, size: int
) -> int:
    upload = store.create_upload(
        discussion_id, owner_id, f"upload-{index}", f"file-{index}.bin", size, PLAIN
    )
    return upload.size


def test_the_pool_holds_a_whole_message() -> None:
    assert UPLOAD_OWNER_BYTES >= MAX_MESSAGE_BYTES
    assert UPLOAD_TOTAL_BYTES >= 2 * MAX_MESSAGE_BYTES
    assert UPLOAD_COUNT >= MAX_FILES


def test_a_200_mib_reservation_is_created(
    pool: tuple[SqliteStore, int, int],
) -> None:
    store, discussion_id, owner_id = pool

    assert reserve(store, discussion_id, owner_id, 1, 200 * MIB) == 200 * MIB


def test_a_full_message_of_reservations_is_created(
    pool: tuple[SqliteStore, int, int],
) -> None:
    store, discussion_id, owner_id = pool

    sizes = [
        reserve(store, discussion_id, owner_id, index, 100 * MIB) for index in range(5)
    ]

    assert sum(sizes) == 500 * MIB


def test_one_byte_over_the_owner_cap_is_still_rejected(
    pool: tuple[SqliteStore, int, int],
) -> None:
    store, discussion_id, owner_id = pool
    for index in range(5):
        reserve(store, discussion_id, owner_id, index, 100 * MIB)

    with pytest.raises(DomainError) as caught:
        reserve(store, discussion_id, owner_id, 9, 1)

    assert caught.value.code == ErrorCode.UPLOAD_CAPACITY
