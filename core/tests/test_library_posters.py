import asyncio
import os
import time
from pathlib import Path

from fora.adapters.media import posters


def part_writer(
    calls: list[Path], gate: asyncio.Event | None = None, *, body: bytes = b"jpeg"
):
    async def extract(source: Path, output: Path) -> bytes | None:
        calls.append(source)
        output.parent.mkdir(parents=True, exist_ok=True)
        partial = output.with_name(f"{output.name}.part")
        partial.write_bytes(body)
        if gate is not None:
            await gate.wait()
        partial.replace(output)
        return output.read_bytes()

    return extract


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


def test_two_readers_of_a_new_file_share_one_extract(
    tmp_path: Path, monkeypatch
) -> None:
    target = tmp_path / "demo.mp4"
    target.write_bytes(b"\0" * 64)
    calls: list[Path] = []

    async def scenario() -> list[bytes | None]:
        gate = asyncio.Event()
        monkeypatch.setattr(posters, "extract", part_writer(calls, gate))
        cache = posters.Posters(tmp_path / "posters")
        readers = [asyncio.create_task(cache.read(target)) for _ in range(2)]
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        gate.set()
        return await asyncio.gather(*readers)

    assert asyncio.run(scenario()) == [b"jpeg", b"jpeg"]
    assert len(calls) == 1
    assert list((tmp_path / "posters").glob("*.part")) == []


def test_six_readers_of_a_new_file_share_one_extract(
    tmp_path: Path, monkeypatch
) -> None:
    target = tmp_path / "demo.mp4"
    target.write_bytes(b"\0" * 64)
    calls: list[Path] = []

    async def scenario() -> list[bytes | None]:
        gate = asyncio.Event()
        monkeypatch.setattr(posters, "extract", part_writer(calls, gate))
        cache = posters.Posters(tmp_path / "posters")
        readers = [asyncio.create_task(cache.read(target)) for _ in range(6)]
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        gate.set()
        return await asyncio.gather(*readers)

    assert asyncio.run(scenario()) == [b"jpeg"] * 6
    assert len(calls) == 1
    assert list((tmp_path / "posters").glob("*.part")) == []


def test_a_failed_generation_is_shared_by_every_reader(
    tmp_path: Path, monkeypatch
) -> None:
    target = tmp_path / "demo.mp4"
    target.write_bytes(b"broken")
    calls: list[Path] = []

    async def scenario() -> list[bytes | None]:
        async def extract(source: Path, output: Path) -> bytes | None:
            calls.append(source)
            await asyncio.sleep(0.01)
            return None

        monkeypatch.setattr(posters, "extract", extract)
        cache = posters.Posters(tmp_path / "posters")
        return await asyncio.gather(*(cache.read(target) for _ in range(6)))

    assert asyncio.run(scenario()) == [None] * 6
    assert len(calls) == 1
    assert list((tmp_path / "posters").glob("*.part")) == []


def test_a_poster_without_a_pointer_is_reclaimed(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "demo.mp4"
    target.write_bytes(b"\0" * 64)
    directory = tmp_path / "posters"
    directory.mkdir()
    orphan = directory / f"{'a' * 64}-1-1.jpg"
    orphan.write_bytes(b"jpeg")

    async def extract(source: Path, output: Path) -> bytes | None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"jpeg")
        return b"jpeg"

    monkeypatch.setattr(posters, "extract", extract)
    cache = posters.Posters(directory)

    assert asyncio.run(cache.read(target)) == b"jpeg"
    assert not orphan.exists()
    assert len(list(directory.glob("*.jpg"))) == 1


def test_trimming_leaves_the_event_loop_running(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "demo.mp4"
    target.write_bytes(b"\0" * 64)

    async def extract(source: Path, output: Path) -> bytes | None:
        await asyncio.sleep(0)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"jpeg")
        return b"jpeg"

    def slow_trim(self: posters.Posters) -> None:
        time.sleep(0.5)

    monkeypatch.setattr(posters, "extract", extract)
    monkeypatch.setattr(posters.Posters, "_trim", slow_trim)

    async def scenario() -> float:
        cache = posters.Posters(tmp_path / "posters")
        reading = asyncio.create_task(cache.read(target))
        await asyncio.sleep(0)
        longest = 0.0
        while not reading.done():
            started = time.monotonic()
            await asyncio.sleep(0.01)
            longest = max(longest, time.monotonic() - started)
        assert reading.result() == b"jpeg"
        return longest

    assert asyncio.run(scenario()) < 0.25


def test_extract_without_ffmpeg_returns_nothing(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "demo.mp4"
    target.write_bytes(b"\0" * 64)
    monkeypatch.setattr(posters.shutil, "which", lambda name: None)

    assert asyncio.run(posters.extract(target, tmp_path / "out.jpg")) is None
    assert not (tmp_path / "out.jpg").exists()
