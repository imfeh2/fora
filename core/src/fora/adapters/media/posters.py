import asyncio
import hashlib
import shutil
from pathlib import Path

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
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
        self._generating: dict[Path, asyncio.Task[bytes | None]] = {}

    async def read(self, target: Path) -> bytes | None:
        poster = self._poster(target)
        cached = self._cached(poster)
        if cached is not None:
            return cached
        return await asyncio.shield(self._generation(target, poster))

    def _generation(self, target: Path, poster: Path) -> asyncio.Task[bytes | None]:
        running = self._generating.get(poster)
        if running is not None:
            return running
        task = asyncio.create_task(self._build(target, poster))
        self._generating[poster] = task
        task.add_done_callback(lambda done: self._forget(poster, done))
        return task

    def _forget(self, poster: Path, done: asyncio.Task[bytes | None]) -> None:
        self._generating.pop(poster, None)
        if not done.cancelled():
            done.exception()

    async def _build(self, target: Path, poster: Path) -> bytes | None:
        async with self._slots:
            cached = self._cached(poster)
            if cached is not None:
                return cached
            produced = await extract(target, poster)
            if produced is None:
                return None
            self._pointer(target).write_text(str(target), encoding="utf-8")
            await asyncio.to_thread(self._trim)
            return produced

    def _cached(self, poster: Path) -> bytes | None:
        try:
            return poster.read_bytes()
        except FileNotFoundError:
            return None

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
        indexed: set[str] = set()
        for pointer in list(self._directory.glob("*.path")):
            digest = pointer.stem
            source = Path(pointer.read_text(encoding="utf-8").strip())
            try:
                stat = source.stat()
            except FileNotFoundError:
                pointer.unlink(missing_ok=True)
                for stale in self._directory.glob(f"{digest}-*.jpg"):
                    stale.unlink(missing_ok=True)
                continue
            indexed.add(digest)
            current = self._directory / (
                f"{digest}-{stat.st_mtime_ns}-{stat.st_size}.jpg"
            )
            for stale in self._directory.glob(f"{digest}-*.jpg"):
                if stale != current:
                    stale.unlink(missing_ok=True)
        kept: list[tuple[int, Path]] = []
        active = set(self._generating)
        for poster in self._directory.glob("*.jpg"):
            if poster.name.split("-")[0] not in indexed and poster not in active:
                poster.unlink(missing_ok=True)
                continue
            kept.append((poster.stat().st_mtime_ns, poster))
        kept.sort()
        for _, old in kept[: max(0, len(kept) - POSTER_LIMIT)]:
            old.unlink(missing_ok=True)


async def extract(target: Path, output: Path) -> bytes | None:
    ffmpeg = shutil.which(FFMPEG)
    if ffmpeg is None:
        return None
    length = await duration(target)
    seconds = POSTER_SECONDS if length is None else min(POSTER_SECONDS, length / 2)
    produced = await _grab(ffmpeg, target, output, seconds)
    if produced is not None or seconds == 0:
        return produced
    return await _grab(ffmpeg, target, output, 0.0)


async def duration(target: Path) -> float | None:
    ffprobe = shutil.which(FFPROBE)
    if ffprobe is None:
        return None
    process = await asyncio.create_subprocess_exec(
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(target),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), POSTER_TIMEOUT)
    except TimeoutError:
        process.kill()
        await process.wait()
        return None
    if process.returncode != 0:
        return None
    try:
        length = float(stdout.decode().strip())
    except ValueError:
        return None
    return length if length > 0 else None


async def _grab(
    ffmpeg: str, target: Path, output: Path, seconds: float
) -> bytes | None:
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(f"{output.name}.part")
    process = await asyncio.create_subprocess_exec(
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        str(seconds),
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
        partial.unlink(missing_ok=True)
        return None
    if process.returncode != 0 or not partial.is_file():
        partial.unlink(missing_ok=True)
        return None
    partial.replace(output)
    return output.read_bytes()
