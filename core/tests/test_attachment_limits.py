import pytest

from fora.core.attachment import (
    MAX_FILE_BYTES,
    MAX_IMAGE_BYTES,
    MAX_MESSAGE_BYTES,
    MIB,
    Attachment,
    validate_attachments,
    validate_upload,
)
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError

IMAGE = "image/png"
PLAIN = "application/octet-stream"


def held(size: int, name: str = "file.bin") -> Attachment:
    return Attachment(
        id="00000000-0000-4000-8000-000000000000",
        name=name,
        size=size,
        media_type=PLAIN,
        sha256="0" * 64,
    )


def test_the_limits_are_the_new_ones() -> None:
    assert MAX_FILE_BYTES == 200 * MIB
    assert MAX_MESSAGE_BYTES == 500 * MIB
    assert MAX_IMAGE_BYTES == 5 * MIB


def test_a_file_at_the_limit_passes() -> None:
    validate_upload("file.bin", MAX_FILE_BYTES, PLAIN)
    validate_upload("file.bin", MAX_FILE_BYTES - 1, PLAIN)


def test_a_file_one_byte_over_is_rejected_with_the_limit_in_the_message() -> None:
    with pytest.raises(DomainError) as caught:
        validate_upload("file.bin", MAX_FILE_BYTES + 1, PLAIN)

    assert caught.value.code == ErrorCode.FILE_TOO_LARGE
    assert str(caught.value) == f"Files must be at most {MAX_FILE_BYTES // MIB} MiB"


def test_a_message_at_the_total_passes() -> None:
    validate_attachments(
        tuple(held(100 * MIB, f"file-{index}.bin") for index in range(5))
    )


def test_a_message_one_byte_over_the_total_is_rejected() -> None:
    attachments = [held(100 * MIB, f"file-{index}.bin") for index in range(5)]
    attachments.append(held(1, "extra.bin"))

    with pytest.raises(DomainError) as caught:
        validate_attachments(tuple(attachments))

    assert caught.value.code == ErrorCode.ATTACHMENTS_TOO_LARGE
    assert (
        str(caught.value)
        == f"Message files must total at most {MAX_MESSAGE_BYTES // MIB} MiB"
    )


def test_an_image_at_the_limit_passes() -> None:
    validate_upload("photo.png", MAX_IMAGE_BYTES, IMAGE)


def test_an_image_one_byte_over_is_rejected() -> None:
    with pytest.raises(DomainError) as caught:
        validate_upload("photo.png", MAX_IMAGE_BYTES + 1, IMAGE)

    assert caught.value.code == ErrorCode.IMAGE_TOO_LARGE
    assert str(caught.value) == f"Images must be at most {MAX_IMAGE_BYTES // MIB} MiB"


def test_a_non_image_may_use_the_file_limit() -> None:
    validate_upload("clip.mp4", MAX_IMAGE_BYTES * 8, "video/mp4")


def test_transport_and_library_limits_follow_the_attachment_limit() -> None:
    from fora.adapters.websocket.server import CLIENT_MAX_BYTES, LIBRARY_MAX_BYTES

    assert LIBRARY_MAX_BYTES == MAX_FILE_BYTES
    assert CLIENT_MAX_BYTES > MAX_FILE_BYTES
