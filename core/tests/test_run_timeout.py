from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from fora.adapters.execution.local import DEFAULT_TIMEOUT, MAX_TIMEOUT, LocalExecution
from fora.adapters.model.runner import PydanticModelRunner
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError


class Settings:
    def get_settings(self, section: str) -> object:
        return None


@pytest.mark.parametrize("timeout", [MAX_TIMEOUT + 1, 60000])
def test_rejects_a_timeout_past_the_maximum(tmp_path: Path, timeout: int) -> None:
    execution = LocalExecution([str(tmp_path)])
    try:
        with pytest.raises(DomainError) as raised:
            execution.run(["true"], cwd=str(tmp_path), timeout=timeout)
    finally:
        execution.close()

    assert raised.value.code == ErrorCode.INVALID_TIMEOUT
    message = str(raised.value)
    assert str(MAX_TIMEOUT) in message
    assert str(DEFAULT_TIMEOUT) in message
    assert "seconds" in message


def test_accepts_the_maximum_timeout(tmp_path: Path) -> None:
    execution = LocalExecution([str(tmp_path)])
    try:
        result = execution.run(["true"], cwd=str(tmp_path), timeout=MAX_TIMEOUT)
    finally:
        execution.close()

    assert result.exit_code == 0


def test_falls_back_to_the_default_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("fora.adapters.execution.local.DEFAULT_TIMEOUT", 1)
    execution = LocalExecution([str(tmp_path)])
    try:
        with pytest.raises(DomainError) as raised:
            execution.run(["sleep", "5"], cwd=str(tmp_path))
    finally:
        execution.close()

    assert raised.value.code == ErrorCode.TIMEOUT
    assert "1 seconds" in str(raised.value)


def test_tool_schema_and_description_bound_the_timeout() -> None:
    runner = PydanticModelRunner(Settings())
    tool = runner._agent._function_toolset.tools["run"]
    prepared = asyncio.run(tool.prepare_tool_def(None))
    assert prepared is not None
    bounded = prepared.parameters_json_schema["properties"]["timeout"]
    integer = next(branch for branch in bounded["anyOf"] if branch["type"] == "integer")

    assert integer["maximum"] == MAX_TIMEOUT
    assert integer["minimum"] == 1
    assert tool.description is not None
    assert str(MAX_TIMEOUT) in tool.description
    assert str(DEFAULT_TIMEOUT) in tool.description
    assert "seconds" in tool.description
