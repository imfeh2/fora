from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

type BlockKind = Literal[
    "context",
    "reminder",
    "preparation",
    "environment",
    "instructions",
    "retry",
    "text",
    "thinking",
    "tool",
]


@dataclass(frozen=True)
class Block:
    kind: BlockKind
    parts: str


@dataclass(frozen=True)
class WindowContent:
    message_heads: tuple[str, ...] = ()
    blocks: tuple[Block, ...] = ()
