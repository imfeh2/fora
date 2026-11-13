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


MEDIA = frozenset(
    {"binary", "image-url", "audio-url", "video-url", "document-url", "uploaded-file"}
)


def _plain(value: Any) -> Any:
    if isinstance(value, dict):
        if value.get("kind") in MEDIA:
            return f"[{value.get('media_type') or value['kind']}]"
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_plain(item) for item in value]
    return value


def _scalar(value: Any) -> str:
    return value if isinstance(value, str) else _dump(value)


def _nested(value: Any) -> bool:
    return (isinstance(value, dict | list) and bool(value)) or (
        isinstance(value, str) and "\n" in value
    )


def _lines(value: Any, indent: str) -> list[str]:
    if isinstance(value, str):
        return [(indent + line).rstrip() for line in value.rstrip("\n").split("\n")]
    if isinstance(value, dict) and value:
        items = [(f"{key}:", item) for key, item in value.items()]
    elif isinstance(value, list) and value:
        items = [("-", item) for item in value]
    else:
        return [indent + _dump(value)]
    lines = []
    for label, item in items:
        if label == "-" and isinstance(item, dict) and item:
            nested = _lines(item, indent + "  ")
            lines.append(f"{indent}- {nested[0].lstrip()}")
            lines.extend(nested[1:])
        elif _nested(item):
            lines.append(indent + label)
            lines.extend(_lines(item, indent + "  "))
        else:
            lines.append(f"{indent}{label} {_scalar(item)}".rstrip())
    return lines


def _text(value: Any) -> str:
    value = _plain(value)
    if isinstance(value, str):
        return value
    return "\n".join(_lines(value, ""))


def _arguments(value: Any) -> str:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return value
    return _dump(value)


def render_block(block: Block) -> str:
    lines = []
    for _, _, part in json.loads(block.parts):
        kind = part["part_kind"]
        if kind in CALLS:
            lines.append(f"{part['tool_name']} {_arguments(part.get('args'))}")
        elif block.kind == "tool" and kind == "retry-prompt":
            lines.append("Error:\n" + _text(part["content"]))
        elif block.kind == "tool":
            lines.append("Result:\n" + _text(part["content"]))
        else:
            lines.append(_text(part["content"]))
    return "\n".join(lines)
