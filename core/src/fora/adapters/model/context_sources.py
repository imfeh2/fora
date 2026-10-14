from collections.abc import Sequence
from dataclasses import replace
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic_ai.messages import ModelMessage, ModelRequest, UserPromptPart

SourceKind = Literal[
    "session_context", "reminder", "preparation", "environment", "ephemeral"
]


class ContextSource(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    part_index: int = Field(ge=0)
    kind: SourceKind
    source_id: str = Field(min_length=1)
    agent_id: int = Field(ge=1)
    sequence: int = Field(ge=1)


class ContextSourcesMetadata(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    version: Literal[1]
    metadata_was_none: bool
    fora_was_missing: bool
    parts: list[ContextSource]


class ContextSources:
    def __init__(self, agent_id: int, sequence: int) -> None:
        self.agent_id = agent_id
        self.sequence = sequence
        self._parts: dict[int, tuple[UserPromptPart, ContextSource]] = {}

    def mark(self, part: UserPromptPart, kind: SourceKind) -> None:
        if id(part) in self._parts:
            existing, source = self._parts[id(part)]
            if existing is not part or source.kind != kind:
                raise ValueError("Context part source is inconsistent")
            return
        self._parts[id(part)] = (
            part,
            ContextSource(
                part_index=0,
                kind=kind,
                source_id=uuid4().hex,
                agent_id=self.agent_id,
                sequence=self.sequence,
            ),
        )

    def _metadata(self, message: ModelRequest) -> ContextSourcesMetadata | None:
        fora = (message.metadata or {}).get("fora")
        if not isinstance(fora, dict) or "context_sources" not in fora:
            return None
        raw = fora["context_sources"]
        if not isinstance(raw, dict) or type(raw.get("version")) is not int:
            return None
        try:
            result = ContextSourcesMetadata.model_validate(raw)
        except ValidationError:
            return None
        seen: set[int] = set()
        for source in result.parts:
            if (
                source.part_index >= len(message.parts)
                or not isinstance(message.parts[source.part_index], UserPromptPart)
                or source.part_index in seen
                or source.agent_id != self.agent_id
                or source.sequence > self.sequence
            ):
                return None
            seen.add(source.part_index)
        return result

    def _original_metadata(
        self, message: ModelRequest, sources: ContextSourcesMetadata
    ) -> dict[str, Any] | None:
        metadata = dict(message.metadata or {})
        fora = dict(metadata["fora"])
        del fora["context_sources"]
        if sources.fora_was_missing and not fora:
            del metadata["fora"]
        else:
            metadata["fora"] = fora
        return None if sources.metadata_was_none and not metadata else metadata

    def restore(self, messages: list[ModelMessage]) -> list[ModelMessage]:
        result: list[ModelMessage] = []
        for message in messages:
            if not isinstance(message, ModelRequest):
                result.append(message)
                continue
            metadata = self._metadata(message)
            if metadata is None:
                result.append(message)
                continue
            for source in metadata.parts:
                part = message.parts[source.part_index]
                assert isinstance(part, UserPromptPart)
                self._parts[id(part)] = (part, source)
            result.append(
                replace(message, metadata=self._original_metadata(message, metadata))
            )
        return result

    def snapshot(
        self, messages: Sequence[ModelMessage], *, persistent: bool = False
    ) -> list[ModelMessage]:
        result: list[ModelMessage] = []
        for message in messages:
            if not isinstance(message, ModelRequest):
                result.append(message)
                continue
            sources: list[ContextSource] = []
            for index, part in enumerate(message.parts):
                saved = self._parts.get(id(part))
                if saved is None or saved[0] is not part:
                    continue
                source = saved[1]
                if persistent and source.kind == "ephemeral":
                    continue
                sources.append(source.model_copy(update={"part_index": index}))
            if not sources:
                result.append(message)
                continue
            original_metadata = message.metadata
            metadata = dict(original_metadata or {})
            original_fora = metadata.get("fora", {})
            if not isinstance(original_fora, dict):
                result.append(message)
                continue
            if "context_sources" in original_fora:
                existing = self._metadata(message)
                if existing is None:
                    result.append(message)
                    continue
                original_metadata = self._original_metadata(message, existing)
                metadata = dict(original_metadata or {})
                original_fora = metadata.get("fora", {})
            marker = ContextSourcesMetadata(
                version=1,
                metadata_was_none=original_metadata is None,
                fora_was_missing="fora" not in metadata,
                parts=sources,
            )
            result.append(
                replace(
                    message,
                    metadata={
                        **metadata,
                        "fora": {
                            **original_fora,
                            "context_sources": marker.model_dump(),
                        },
                    },
                )
            )
        return result
