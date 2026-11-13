from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from pydantic_ai.messages import ModelMessage, ModelMessagesTypeAdapter

from fora.core.blocks import Block, BlockKind, WindowContent
from fora.runtime.reminder import HistoryPersistenceError, HistoryValidationError

CALLS = frozenset({"tool-call", "builtin-tool-call"})
RESULTS = frozenset({"tool-return", "retry-prompt", "builtin-tool-return"})
OWN_KINDS: dict[str, BlockKind] = {
    "user-prompt": "input",
    "system-prompt": "input",
    "retry-prompt": "input",
    "text": "text",
    "thinking": "thinking",
}


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def to_blocks(messages: Sequence[ModelMessage]) -> WindowContent:
    try:
        encoded = ModelMessagesTypeAdapter.dump_json(list(messages))
    except Exception as error:
        raise HistoryPersistenceError("Could not serialize model history") from error
    heads = []
    blocks: list[tuple[BlockKind, list[Any]]] = []
    waiting: dict[str, list[int]] = {}
    for position, message in enumerate(json.loads(encoded)):
        parts = message["parts"]
        message["parts"] = len(parts)
        heads.append(_dump(message))
        for index, part in enumerate(parts):
            entry = [position, index, part]
            kind = part["part_kind"]
            call_id = part.get("tool_call_id")
            if kind in CALLS:
                waiting.setdefault(call_id, []).append(len(blocks))
                blocks.append(("tool", [entry]))
            elif kind in RESULTS and waiting.get(call_id):
                blocks[waiting[call_id].pop(0)][1].append(entry)
            elif kind in OWN_KINDS:
                blocks.append((OWN_KINDS[kind], [entry]))
            else:
                raise HistoryPersistenceError(
                    f"Message part {kind} has no block to belong to"
                )
    return WindowContent(
        tuple(heads), tuple(Block(kind, _dump(entries)) for kind, entries in blocks)
    )


def from_blocks(content: WindowContent) -> list[ModelMessage]:
    try:
        messages = [json.loads(head) for head in content.message_heads]
        placed: list[dict[int, Any]] = [{} for _ in messages]
        for block in content.blocks:
            for position, index, part in json.loads(block.parts):
                if index in placed[position]:
                    raise HistoryValidationError("Two blocks hold the same part")
                placed[position][index] = part
        for message, parts in zip(messages, placed, strict=True):
            if sorted(parts) != list(range(message["parts"])):
                raise HistoryValidationError("A message is missing some of its parts")
            message["parts"] = [parts[index] for index in range(len(parts))]
        return ModelMessagesTypeAdapter.validate_json(_dump(messages))
    except HistoryValidationError:
        raise
    except (ValueError, TypeError, IndexError) as error:
        raise HistoryValidationError("Stored model history is invalid") from error
