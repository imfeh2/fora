from collections.abc import Mapping
from dataclasses import dataclass, fields
from typing import Any

from fora.core.context_budget import (
    CONTEXT_WINDOW_RATIO_DEFAULT,
    CONTEXT_WINDOW_RATIO_MAX,
    CONTEXT_WINDOW_RATIO_MIN,
)
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError


@dataclass(frozen=True)
class AgentParameters:
    context_window_tokens: int | None = None
    context_window_ratio_percent: int = CONTEXT_WINDOW_RATIO_DEFAULT
    exchange_nudge_after: int = 6
    max_concurrent_turns: int = 4
    idle_streak_after: int = 3
    no_tool_turns_before_pause: int = 3
    memory_index_bytes: int = 16_384
    token_limit: int = 0
    request_limit: int = 0


def agent_parameters(values: Mapping[str, object] | None) -> AgentParameters:
    return AgentParameters(**validate_parameters({} if values is None else values))


def validate_parameters(values: Mapping[str, object]) -> dict[str, Any]:
    names = {field.name for field in fields(AgentParameters)}
    validated: dict[str, Any] = {}
    for key, value in values.items():
        if key not in names:
            raise DomainError(
                ErrorCode.INVALID_SETTING, f"Unknown Agent parameter: {key}"
            )
        minimum = 0 if key in ("token_limit", "request_limit") else 1
        if key == "context_window_tokens":
            if value is not None and (type(value) is not int or value < 1):
                raise DomainError(
                    ErrorCode.INVALID_PARAMETER,
                    "Agent parameter context_window_tokens must be empty or a"
                    " positive integer",
                )
            validated[key] = value
            continue
        if key == "context_window_ratio_percent":
            if type(value) is not int or not (
                CONTEXT_WINDOW_RATIO_MIN <= value <= CONTEXT_WINDOW_RATIO_MAX
            ):
                raise DomainError(
                    ErrorCode.INVALID_PARAMETER,
                    "Agent parameter context_window_ratio_percent must be an integer"
                    f" between {CONTEXT_WINDOW_RATIO_MIN} and {CONTEXT_WINDOW_RATIO_MAX}",
                )
            validated[key] = value
            continue
        if type(value) is not int or value < minimum:
            kind = "non-negative" if minimum == 0 else "positive"
            raise DomainError(
                ErrorCode.INVALID_PARAMETER,
                f"Agent parameter {key} must be a {kind} integer",
            )
        validated[key] = value
    return validated
