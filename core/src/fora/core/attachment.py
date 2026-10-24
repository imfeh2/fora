from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError

MIB = 1024 * 1024
MAX_FILES = 10
MAX_FILE_BYTES = 20 * MIB
MAX_MESSAGE_BYTES = 50 * MIB
MAX_IMAGE_BYTES = 5 * MIB
MAX_IMAGE_SIDE = 8192
MAX_IMAGE_PIXELS = 20_000_000
IMAGE_TYPES = frozenset({"image/png", "image/jpeg", "image/webp"})


@dataclass(frozen=True)
class Attachment:
    id: str
    name: str
    size: int
    media_type: str
    sha256: str
    width: int | None = None
    height: int | None = None


@dataclass(frozen=True)
class ImageData:
    data: bytes
    media_type: str
    width: int
    height: int


@dataclass(frozen=True)
class ViewedImage:
    path: str
    image: ImageData


@dataclass(frozen=True)
class Upload:
    id: str
    discussion_id: int
    owner_id: int
    client_upload_id: str
    name: str
    size: int
    media_type: str
    state: str
    expires_at: float


def identifier(value: object) -> str:
    if not isinstance(value, str):
        raise DomainError(ErrorCode.INVALID_ID, "Expected a UUID")
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise DomainError(ErrorCode.INVALID_ID, "Expected a UUID") from error
    if str(parsed) != value:
        raise DomainError(ErrorCode.INVALID_ID, "Expected a canonical UUID")
    return value


def validate_upload(name: object, size: object, media_type: object) -> None:
    if (
        not isinstance(name, str)
        or not name.strip()
        or len(name) > 255
        or any(ord(char) < 32 or ord(char) == 127 for char in name)
        or "/" in name
        or "\\" in name
        or name in {".", ".."}
    ):
        raise DomainError(
            ErrorCode.INVALID_FILENAME, "Choose a filename of 1–255 characters"
        )
    if type(size) is not int or not 0 <= size <= MAX_FILE_BYTES:
        raise DomainError(ErrorCode.FILE_TOO_LARGE, "Files must be at most 20 MiB")
    if not isinstance(media_type, str) or len(media_type) > 127:
        raise DomainError(ErrorCode.INVALID_MEDIA_TYPE, "Invalid file media type")
    if media_type in IMAGE_TYPES and size > MAX_IMAGE_BYTES:
        raise DomainError(ErrorCode.IMAGE_TOO_LARGE, "Images must be at most 5 MiB")


def validate_attachments(attachments: tuple[Attachment, ...]) -> None:
    if len(attachments) > MAX_FILES:
        raise DomainError(
            ErrorCode.TOO_MANY_FILES, "A message can contain at most 10 files"
        )
    if sum(item.size for item in attachments) > MAX_MESSAGE_BYTES:
        raise DomainError(
            ErrorCode.ATTACHMENTS_TOO_LARGE, "Message files must total at most 50 MiB"
        )
