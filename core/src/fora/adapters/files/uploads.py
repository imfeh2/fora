from __future__ import annotations

import hashlib
import os
import stat
import sys
import warnings
from io import BytesIO
from pathlib import Path
from typing import BinaryIO

from PIL import Image, UnidentifiedImageError

from fora.core.attachment import (
    IMAGE_TYPES,
    MAX_IMAGE_BYTES,
    MAX_IMAGE_PIXELS,
    MAX_IMAGE_SIDE,
    Attachment,
    ImageData,
    Upload,
    identifier,
)
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError


def decode_image(data: bytes) -> ImageData:
    if len(data) > MAX_IMAGE_BYTES:
        raise DomainError(ErrorCode.IMAGE_TOO_LARGE, "Images must be at most 5 MiB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.format not in {"PNG", "JPEG", "WEBP"}:
                    raise DomainError(
                        ErrorCode.UNSUPPORTED_IMAGE, "Choose a PNG, JPEG or WebP image"
                    )
                width, height = image.size
                if (
                    max(width, height) > MAX_IMAGE_SIDE
                    or width * height > MAX_IMAGE_PIXELS
                ):
                    raise DomainError(
                        ErrorCode.IMAGE_DIMENSIONS_EXCEEDED,
                        "Images must fit 8192 pixels per side and 20 MP",
                    )
                if getattr(image, "n_frames", 1) != 1:
                    raise DomainError(ErrorCode.ANIMATED_IMAGE, "Choose a static image")
                media_type = Image.MIME[image.format]
                image.verify()
            with Image.open(BytesIO(data)) as image:
                image.load()
    except (
        UnidentifiedImageError,
        OSError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as error:
        raise DomainError(
            ErrorCode.INVALID_IMAGE, "The image cannot be decoded"
        ) from error
    return ImageData(data, media_type, width, height)


class DirectoryUploads:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, discussion_id: int, attachment_id: str) -> str:
        return str(self.root / str(discussion_id) / identifier(attachment_id))

    def writer(self, upload: Upload) -> BinaryIO:
        target = Path(self.path(upload.discussion_id, upload.id) + ".part")
        target.parent.mkdir(exist_ok=True)
        return target.open("xb")

    def discard(self, upload: Upload) -> None:
        stored = self.path(upload.discussion_id, upload.id)
        Path(stored + ".part").unlink(missing_ok=True)
        Path(stored).unlink(missing_ok=True)

    def relocate(self, upload_id: str, discussion_id: int) -> None:
        for suffix in ("", ".part"):
            legacy = self.root / (identifier(upload_id) + suffix)
            if legacy.exists():
                target = Path(self.path(discussion_id, upload_id) + suffix)
                target.parent.mkdir(exist_ok=True)
                os.replace(legacy, target)

    def complete(self, upload: Upload) -> Attachment:
        stored = self.path(upload.discussion_id, upload.id)
        temporary = Path(stored + ".part")
        with temporary.open("rb") as source:
            if os.fstat(source.fileno()).st_size != upload.size:
                raise DomainError(
                    ErrorCode.UPLOAD_INCOMPLETE, "The uploaded file size does not match"
                )
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        media_type = "application/octet-stream"
        width = height = None
        if upload.media_type in IMAGE_TYPES:
            with temporary.open("rb") as source:
                image = decode_image(source.read(MAX_IMAGE_BYTES + 1))
            media_type, width, height = image.media_type, image.width, image.height
        os.replace(temporary, stored)
        if sys.platform != "win32":
            descriptor = os.open(Path(stored).parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        return Attachment(
            upload.id,
            upload.discussion_id,
            upload.name,
            upload.size,
            media_type,
            digest,
            width,
            height,
        )

    def reader(self, attachment: Attachment) -> BinaryIO:
        path = Path(self.path(attachment.discussion_id, attachment.id))
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size != attachment.size:
                raise DomainError(
                    ErrorCode.ATTACHMENT_INVALID,
                    "The stored attachment is not a valid file",
                )
            source = path.open("rb")
        except FileNotFoundError as error:
            raise DomainError(
                ErrorCode.ATTACHMENT_MISSING, "The attachment file is missing"
            ) from error
        try:
            opened = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_size != attachment.size
                or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino)
            ):
                raise DomainError(
                    ErrorCode.ATTACHMENT_INVALID,
                    "The stored attachment is not a valid file",
                )
            if hashlib.file_digest(source, "sha256").hexdigest() != attachment.sha256:
                raise DomainError(
                    ErrorCode.ATTACHMENT_CHANGED, "The attachment content has changed"
                )
            source.seek(0)
        except BaseException:
            source.close()
            raise
        return source
