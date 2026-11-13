from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import replace
from typing import Any

from pydantic_ai.messages import (
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    UserPromptPart,
)

from fora.core.blocks import Block, BlockKind, WindowContent
from fora.runtime.reminder import HistoryPersistenceError, HistoryValidationError

CALLS = frozenset({"tool-call", "builtin-tool-call"})
RESULTS = frozenset({"tool-return", "builtin-tool-return"})
OWN_KINDS: dict[str, BlockKind] = {
    "retry-feedback": "retry",
    "text": "text",
    "thinking": "thinking",
}


class PartKinds:
    def __init__(self) -> None:
        self._kinds: dict[int, tuple[UserPromptPart, BlockKind | None]] = {}

    def mark(self, part: UserPromptPart, kind: BlockKind) -> None:
        self._kinds[id(part)] = (part, kind)

    def mark_ephemeral(self, part: UserPromptPart) -> None:
        self._kinds[id(part)] = (part, None)

    def _entry(self, part: Any) -> tuple[bool, BlockKind | None]:
        saved = self._kinds.get(id(part))
        if saved is None or saved[0] is not part:
            return False, None
        return True, saved[1]

    def kind(self, part: UserPromptPart) -> BlockKind:
        known, kind = self._entry(part)
        if not known or kind is None:
            raise HistoryPersistenceError("A prompt part has no block kind")
        return kind

    def persistent(self, messages: Sequence[ModelMessage]) -> list[ModelMessage]:
        result: list[ModelMessage] = []
        for message in messages:
            if isinstance(message, ModelRequest):
                parts = [
                    part for part in message.parts if self._entry(part) != (True, None)
                ]
                if len(parts) != len(message.parts):
                    message = replace(message, parts=parts)
            result.append(message)
        return result


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def to_blocks(messages: Sequence[ModelMessage], kinds: PartKinds) -> WindowContent:
    try:
        encoded = ModelMessagesTypeAdapter.dump_json(list(messages))
    except Exception as error:
        raise HistoryPersistenceError("Could not serialize model history") from error
    heads = []
    blocks: list[tuple[BlockKind, list[Any]]] = []
    waiting: dict[str, list[int]] = {}
    for position, (original, message) in enumerate(
        zip(messages, json.loads(encoded), strict=True)
    ):
        parts = message["parts"]
        message["parts"] = len(parts)
        heads.append(_dump(message))
        for index, (source, part) in enumerate(zip(original.parts, parts, strict=True)):
            entry = [position, index, part]
            kind = part["part_kind"]
            call_id = part.get("tool_call_id")
            if kind in CALLS:
                waiting.setdefault(call_id, []).append(len(blocks))
                blocks.append(("tool", [entry]))
            elif kind in RESULTS and waiting.get(call_id):
                blocks[waiting[call_id].pop(0)][1].append(entry)
            elif isinstance(source, UserPromptPart):
                blocks.append((kinds.kind(source), [entry]))
            elif kind in OWN_KINDS:
                blocks.append((OWN_KINDS[kind], [entry]))
            else:
                raise HistoryPersistenceError(
                    f"Message part {kind} has no block to belong to"
                )
    return WindowContent(
        tuple(heads), tuple(Block(kind, _dump(entries)) for kind, entries in blocks)
    )


def from_blocks(
    content: WindowContent, kinds: PartKinds | None = None
) -> list[ModelMessage]:
    try:
        messages = [json.loads(head) for head in content.message_heads]
        placed: list[dict[int, Any]] = [{} for _ in messages]
        prompts: list[tuple[int, int, BlockKind]] = []
        for block in content.blocks:
            for position, index, part in json.loads(block.parts):
                if index in placed[position]:
                    raise HistoryValidationError("Two blocks hold the same part")
                placed[position][index] = part
                if part["part_kind"] == "user-prompt":
                    prompts.append((position, index, block.kind))
        for message, parts in zip(messages, placed, strict=True):
            if sorted(parts) != list(range(message["parts"])):
                raise HistoryValidationError("A message is missing some of its parts")
            message["parts"] = [parts[index] for index in range(len(parts))]
        decoded = ModelMessagesTypeAdapter.validate_json(_dump(messages))
        if kinds is not None:
            for position, index, kind in prompts:
                part = decoded[position].parts[index]
                assert isinstance(part, UserPromptPart)
                kinds.mark(part, kind)
        return decoded
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
        elif block.kind == "tool":
            label = "Result" if part.get("outcome", "success") == "success" else "Error"
            lines.append(f"{label}:\n" + _text(part["content"]))
        else:
            lines.append(_text(part["content"]))
    return "\n".join(lines)
