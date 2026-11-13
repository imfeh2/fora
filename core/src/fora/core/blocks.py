from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

type BlockKind = Literal["input", "text", "thinking", "tool"]


@dataclass(frozen=True)
class Block:
    kind: BlockKind
    parts: str


@dataclass(frozen=True)
class WindowContent:
    message_heads: tuple[str, ...] = ()
    blocks: tuple[Block, ...] = ()
