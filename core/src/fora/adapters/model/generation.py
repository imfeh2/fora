from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import jiter
from pydantic import TypeAdapter
from pydantic_ai.messages import (
    ModelResponsePart,
    PartDeltaEvent,
    PartEndEvent,
    PartStartEvent,
    ToolCallPart,
)

import ijson
from fora.ports.agent import (
    GenerationUpdate,
    ModelRequestHandle,
    ModelRequestRecorder,
    SendPreviewCandidate,
)


class GenerationStream:
    def __init__(
        self, recorder: ModelRequestRecorder, handle: ModelRequestHandle
    ) -> None:
        self._recorder = recorder
        self._handle = handle
        self._parts: dict[int, ModelResponsePart] = {}
        self._adapter: TypeAdapter[ModelResponsePart] = TypeAdapter(
            ModelResponsePart, config={"ser_json_bytes": "base64"}
        )

    def _save(
        self,
        index: int,
        part: ModelResponsePart,
        *,
        status: str = "generating",
        error: str | None = None,
        replace_part: bool = False,
    ) -> None:
        self._parts[index] = part
        evaluation = (
            evaluate_preview(part.tool_name, part.args)
            if isinstance(part, ToolCallPart)
            else PreviewEvaluation()
        )
        self._recorder.generation(
            self._handle,
            index,
            GenerationUpdate(
                part_kind=part.part_kind,
                content_json=self._adapter.dump_json(part).decode("utf-8"),
                status=status,
                error=error,
                preview=evaluation.candidate,
                preview_error=evaluation.error,
                replace_part=replace_part,
            ),
        )

    def event(self, event: PartStartEvent | PartDeltaEvent | PartEndEvent) -> None:
        if isinstance(event, PartStartEvent):
            self._save(event.index, event.part, replace_part=True)
        elif isinstance(event, PartDeltaEvent):
            self._save(event.index, event.delta.apply(self._parts[event.index]))
        else:
            self._save(event.index, event.part, status="completed")

    def response(self, parts: list[ModelResponsePart]) -> None:
        for index, part in enumerate(parts):
            self._save(index, part, status="completed")

    def tool_result(self, index: int, status: str, error: str | None) -> None:
        self._save(index, self._parts[index], status=status, error=error)


@dataclass(frozen=True)
class PreviewEvaluation:
    candidate: SendPreviewCandidate | None = None
    error: str | None = None


def evaluate_preview(
    tool_name: str, args: str | dict[str, Any] | None
) -> PreviewEvaluation:
    if tool_name != "discussion" or not args:
        return PreviewEvaluation()
    if isinstance(args, dict):
        values = args
        complete = {"action", "discussion_id"}
    else:
        encoded = args.encode("utf-8")
        events: ijson.sendable_list[tuple[str, str, object]] = ijson.sendable_list()
        parser = ijson.parse_coro(events)
        malformed = False
        try:
            parser.send(encoded)
        except ijson.JSONError:
            malformed = True
        finally:
            completed_events = tuple(events)
            try:
                parser.close()
            except ijson.IncompleteJSONError:
                pass
        if malformed:
            return PreviewEvaluation(error="Tool parameters contain invalid JSON")
        if not completed_events:
            return PreviewEvaluation()
        keys: set[str] = set()
        complete = set()
        for prefix, event, value in completed_events:
            if prefix == "" and event == "map_key":
                assert isinstance(value, str)
                if value in keys:
                    return PreviewEvaluation(
                        error="Tool parameters contain duplicate fields"
                    )
                keys.add(value)
            if (prefix, event) in (("action", "string"), ("discussion_id", "number")):
                complete.add(prefix)
        try:
            values = jiter.from_json(
                encoded,
                allow_inf_nan=False,
                partial_mode="trailing-strings",
                catch_duplicate_keys=True,
            )
        except ValueError:
            return PreviewEvaluation(error="Tool parameters contain invalid JSON")
        if not isinstance(values, dict):
            return PreviewEvaluation()
    if not {"action", "discussion_id"} <= complete or values.get("action") != "send":
        return PreviewEvaluation()
    target = values.get("discussion_id")
    body = values.get("body")
    if (
        type(target) is not int
        or not 1 <= target <= 2**63 - 1
        or not isinstance(body, str)
    ):
        return PreviewEvaluation()
    return PreviewEvaluation(SendPreviewCandidate(target, body))
