import asyncio
import hashlib
import shutil
from pathlib import Path

FFMPEG = "ffmpeg"
POSTER_SECONDS = 0.5
POSTER_WIDTH = 640
POSTER_QUALITY = 5
POSTER_TIMEOUT = 5.0
POSTER_WORKERS = 2
POSTER_LIMIT = 256


class Posters:
    def __init__(self, directory: Path, *, workers: int = POSTER_WORKERS) -> None:
        self._directory = directory
        self._slots = asyncio.Semaphore(workers)

    async def read(self, target: Path) -> bytes | None:
        poster = self._poster(target)
        if poster.is_file():
            return poster.read_bytes()
        async with self._slots:
            if poster.is_file():
                return poster.read_bytes()
            produced = await extract(target, poster)
            if produced is None:
                return None
            self._pointer(target).write_text(str(target), encoding="utf-8")
            self._trim()
            return produced

    def _digest(self, target: Path) -> str:
        return hashlib.sha256(str(target).encode()).hexdigest()

    def _poster(self, target: Path) -> Path:
        stat = target.stat()
        return self._directory / (
            f"{self._digest(target)}-{stat.st_mtime_ns}-{stat.st_size}.jpg"
        )

    def _pointer(self, target: Path) -> Path:
        return self._directory / f"{self._digest(target)}.path"

    def _trim(self) -> None:
        for pointer in self._directory.glob("*.path"):
            source = Path(pointer.read_text(encoding="utf-8").strip())
            digest = pointer.stem
            if not source.is_file():
                pointer.unlink(missing_ok=True)
                for stale in self._directory.glob(f"{digest}-*.jpg"):
                    stale.unlink(missing_ok=True)
                continue
            stat = source.stat()
            current = self._directory / (
                f"{digest}-{stat.st_mtime_ns}-{stat.st_size}.jpg"
            )
            for stale in self._directory.glob(f"{digest}-*.jpg"):
                if stale != current:
                    stale.unlink(missing_ok=True)
        posters = sorted(
            self._directory.glob("*.jpg"), key=lambda path: path.stat().st_mtime
        )
        for old in posters[: max(0, len(posters) - POSTER_LIMIT)]:
            old.unlink(missing_ok=True)


async def extract(target: Path, output: Path) -> bytes | None:
    ffmpeg = shutil.which(FFMPEG)
    if ffmpeg is None:
        return None
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(f"{output.name}.part")
    process = await asyncio.create_subprocess_exec(
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        str(POSTER_SECONDS),
        "-i",
        str(target),
        "-frames:v",
        "1",
        "-vf",
        f"scale='min({POSTER_WIDTH},iw)':-2",
        "-q:v",
        str(POSTER_QUALITY),
        "-f",
        "image2",
        "-y",
        str(partial),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await asyncio.wait_for(process.wait(), POSTER_TIMEOUT)
    except TimeoutError:
        process.kill()
        await process.wait()
        return None
    if process.returncode != 0 or not partial.is_file():
        partial.unlink(missing_ok=True)
        return None
    partial.replace(output)
    return output.read_bytes()
