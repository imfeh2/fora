import asyncio
import os
from pathlib import Path

from fora.adapters.media import posters


def test_poster_is_generated_once_and_reused(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "demo.mp4"
    target.write_bytes(b"\0" * 64)
    calls: list[Path] = []

    async def extract(source: Path, output: Path) -> bytes | None:
        calls.append(source)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"jpeg")
        return b"jpeg"

    monkeypatch.setattr(posters, "extract", extract)
    cache = posters.Posters(tmp_path / "posters")

    assert asyncio.run(cache.read(target)) == b"jpeg"
    assert asyncio.run(cache.read(target)) == b"jpeg"
    assert len(calls) == 1


def test_a_changed_file_gets_a_new_poster(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "demo.mp4"
    target.write_bytes(b"\0" * 64)
    calls: list[Path] = []

    async def extract(source: Path, output: Path) -> bytes | None:
        calls.append(source)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"jpeg")
        return b"jpeg"

    monkeypatch.setattr(posters, "extract", extract)
    cache = posters.Posters(tmp_path / "posters")

    asyncio.run(cache.read(target))
    target.write_bytes(b"\1" * 80)
    os.utime(target, (1, 1))
    asyncio.run(cache.read(target))
    assert len(calls) == 2


def test_a_failed_poster_is_not_cached(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "demo.mp4"
    target.write_bytes(b"broken")
    calls: list[Path] = []

    async def extract(source: Path, output: Path) -> bytes | None:
        calls.append(source)
        return None

    monkeypatch.setattr(posters, "extract", extract)
    cache = posters.Posters(tmp_path / "posters")

    assert asyncio.run(cache.read(target)) is None
    assert asyncio.run(cache.read(target)) is None
    assert len(calls) == 2


def test_extract_without_ffmpeg_returns_nothing(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "demo.mp4"
    target.write_bytes(b"\0" * 64)
    monkeypatch.setattr(posters.shutil, "which", lambda name: None)

    assert asyncio.run(posters.extract(target, tmp_path / "out.jpg")) is None
    assert not (tmp_path / "out.jpg").exists()
