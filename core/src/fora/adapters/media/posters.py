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


class Posters:
    def __init__(self, directory: Path, *, workers: int = POSTER_WORKERS) -> None:
        self._directory = directory
        self._slots = asyncio.Semaphore(workers)

    async def read(self, target: Path) -> bytes | None:
        cache = self._cache(target)
        if cache.is_file():
            return cache.read_bytes()
        async with self._slots:
            if cache.is_file():
                return cache.read_bytes()
            return await extract(target, cache)

    def _cache(self, target: Path) -> Path:
        stat = target.stat()
        digest = hashlib.sha256(
            f"{target}\0{stat.st_mtime_ns}\0{stat.st_size}".encode()
        ).hexdigest()
        return self._directory / f"{digest}.jpg"


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
