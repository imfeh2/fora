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
    assert len(list((tmp_path / "posters").glob("*.jpg"))) == 1


def test_a_removed_source_takes_its_poster_with_it(tmp_path: Path, monkeypatch) -> None:
    first = tmp_path / "first.mp4"
    first.write_bytes(b"\0" * 64)
    second = tmp_path / "second.mp4"
    second.write_bytes(b"\0" * 64)
    third = tmp_path / "third.mp4"
    third.write_bytes(b"\0" * 64)

    async def extract(source: Path, output: Path) -> bytes | None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"jpeg")
        return b"jpeg"

    monkeypatch.setattr(posters, "extract", extract)
    cache = posters.Posters(tmp_path / "posters")

    asyncio.run(cache.read(first))
    asyncio.run(cache.read(second))
    first.unlink()
    asyncio.run(cache.read(third))

    assert len(list((tmp_path / "posters").glob("*.jpg"))) == 2
    assert len(list((tmp_path / "posters").glob("*.path"))) == 2


def test_the_cache_keeps_a_bounded_number_of_posters(
    tmp_path: Path, monkeypatch
) -> None:
    async def extract(source: Path, output: Path) -> bytes | None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"jpeg")
        return b"jpeg"

    monkeypatch.setattr(posters, "extract", extract)
    monkeypatch.setattr(posters, "POSTER_LIMIT", 3)
    cache = posters.Posters(tmp_path / "posters")

    for index in range(6):
        source = tmp_path / f"clip-{index}.mp4"
        source.write_bytes(b"\0" * 64)
        asyncio.run(cache.read(source))

    assert len(list((tmp_path / "posters").glob("*.jpg"))) == 3


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
