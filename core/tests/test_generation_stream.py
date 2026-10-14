import asyncio
import json
from dataclasses import replace

import httpx
import httpx2
import pytest
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI
from pydantic_ai import ModelMessagesTypeAdapter, models
from pydantic_ai.messages import (
    ModelRequest,
    PartDeltaEvent,
    PartEndEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ToolCallPart,
    ToolCallPartDelta,
    UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.openai import OpenAIProvider
from test_generation_runtime import records
from test_runner import FakeSettings, model_values, request
from test_tools import tools_for, world

from fora.adapters.model.generation import GenerationStream
from fora.adapters.model.runner import LiveModel, PydanticModelRunner
from fora.core.errors import DomainError
from fora.runtime.scheduler import _TurnRequestRecorder
from fora.tools import TurnBinding

__all__ = ["records", "world"]


def test_sdk_part_replacement_and_final_part_keep_one_persisted_identity(records):
    organization, history, _run, recorder, handle, events, human, first, second = (
        records
    )
    stream = GenerationStream(recorder, handle)
    stream.event(PartStartEvent(index=0, part=TextPart("initial")))
    stream.event(PartDeltaEvent(index=0, delta=TextPartDelta(" text")))
    stream.event(PartEndEvent(index=0, part=TextPart("final text")))
    key = recorder.generation_key(handle, 0)
    saved = history.generation.part(key)
    assert saved.status == "completed"
    stream.event(PartStartEvent(index=0, part=ThinkingPart("new reasoning")))
    replaced = history.generation.part(key)
    assert replaced.revision > saved.revision
    assert replaced.part_kind == "thinking"
    assert (
        history.generation.part_text(key, replaced.revision, field="content").value
        == "new reasoning"
    )
    stream.event(
        PartStartEvent(index=0, part=ToolCallPart("discus", None, "temporary"))
    )
    stream.event(
        PartDeltaEvent(
            index=0,
            delta=ToolCallPartDelta(
                tool_name_delta="sion",
                tool_call_id="actual",
                args_delta={
                    "action": "send",
                    "discussion_id": first,
                    "body": "@You 😀",
                },
            ),
        )
    )
    recorder._generation.flush()
    preview = history.generation.preview(key)
    assert preview.discussion_id == first
    stream.event(
        PartStartEvent(
            index=0,
            part=ToolCallPart(
                "discussion",
                {"action": "send", "discussion_id": second, "body": "@You updated"},
                "replaced",
            ),
        )
    )
    assert history.generation.previews(first, human) == ()
    assert history.generation.preview(key).discussion_id == second
    stream.event(
        PartEndEvent(
            index=0,
            part=ToolCallPart(
                "discussion", {"action": "read", "discussion_id": second}, "replaced"
            ),
        )
    )
    assert history.generation.previews(second, human) == ()
    assert organization.message_count(first) == organization.message_count(second) == 0
    assert all("body" not in payload for name, payload in events)


@pytest.mark.parametrize(
    "suffix,reason",
    [
        (',"action":"send"}', "Tool parameters contain duplicate fields"),
        (" !}", "Tool parameters contain invalid JSON"),
    ],
)
@pytest.mark.parametrize("remove_sender", [False, True])
@pytest.mark.parametrize("failure_stage", ["tool", "request"])
def test_sdk_parameter_failure_preserves_the_authorized_preview_through_part_and_tool_end(
    records, suffix, reason, remove_sender, failure_stage
):
    organization, history, run, recorder, handle, events, human, first, second = records
    stream = GenerationStream(recorder, handle)
    args = json.dumps(
        {"action": "send", "discussion_id": first, "body": "@You received 😀"},
        ensure_ascii=False,
    )[:-1]
    stream.event(PartStartEvent(index=0, part=ToolCallPart("discussion", args, "send")))
    key = recorder.generation_key(handle, 0)
    original = history.generation.preview(key)
    assert original is not None and original.discussion_id == first
    if remove_sender:
        organization.change_discussion_members(first, [run.agent_id], remove=True)
    stream.event(PartDeltaEvent(index=0, delta=ToolCallPartDelta(args_delta=suffix)))
    recorder._generation.flush()
    for part_status, failure_reason in (
        ("generating", reason),
        ("completed", reason),
        (
            "failed",
            "Tool execution failed" if failure_stage == "tool" else "Request failed",
        ),
    ):
        if part_status == "completed":
            stream.event(
                PartEndEvent(
                    index=0, part=ToolCallPart("discussion", args + suffix, "send")
                )
            )
        elif part_status == "failed":
            if failure_stage == "tool":
                stream.tool_result(0, "failed", failure_reason)
            else:
                recorder._generation.finish(handle, failure_reason)
        saved = history.generation.part(key)
        preview = history.generation.preview(key)
        assert saved.status == part_status
        assert preview.preview_id == original.preview_id
        assert preview.key == original.key
        assert preview.revision == saved.revision
        assert preview.status == "failed" and preview.error == failure_reason
        assert (
            json.loads(history.generation.part_text(key, saved.revision).value)["args"]
            == args + suffix
        )
        if remove_sender:
            assert preview.discussion_id is None
            assert history.generation.previews(first, human) == ()
            with pytest.raises(DomainError, match="not visible"):
                history.generation.visible_preview(preview.preview_id, first, human)
        else:
            assert preview.discussion_id == first
            assert history.generation.previews(first, human) == (preview,)
            assert (
                history.generation.preview_text(
                    preview.preview_id, first, human, preview.revision
                ).value
                == "@You received 😀"
            )
        assert history.generation.previews(second, human) == ()
    recorder._generation.finish(handle, "Request failed")
    assert history.generation.preview(key) == preview
    assert organization.message_count(first) == 0
    assert organization.pending(human) == ()
    assert all(
        "body" not in payload and "error" not in payload for _name, payload in events
    )


def test_real_stream_executes_send_once_and_maps_the_visible_preview(world):
    history = world.history
    store = world.store
    discussion = store.create_discussion("Work", [1, 2, 3])
    run = history.start_run(2)
    events = []
    recorder = _TurnRequestRecorder(
        history,
        run,
        1,
        lambda phase: None,
        lambda name, value: events.append((name, value)),
    )
    seen = []
    calls = 0

    async def stream(messages, info):
        nonlocal calls
        calls += 1
        if calls == 2:
            yield "done"
            return
        yield {
            0: DeltaToolCall(
                name="discussion",
                json_args='{"body":"@You hello 😀","action":"send","discussion_id":',
            )
        }
        assert history.generation.previews(discussion.id, 1) == ()
        yield {0: DeltaToolCall(json_args=str(discussion.id))}
        assert history.generation.previews(discussion.id, 1) == ()
        yield {0: DeltaToolCall(json_args=',"limit":null', tool_call_id="send")}
        await asyncio.sleep(0.08)
        preview = history.generation.previews(discussion.id, 1)[0]
        seen.append(preview.preview_id)
        assert preview.status == "generating"
        assert (
            history.generation.preview_text(
                preview.preview_id, discussion.id, 1, preview.revision
            ).value
            == "@You hello 😀"
        )
        assert store.message_count(discussion.id) == 0
        assert store.pending(1) == ()
        yield {0: DeltaToolCall(json_args="}")}

    settings = FakeSettings()
    settings.set_settings("model", model_values("local"))
    tools = tools_for(
        world,
        2,
        turn=TurnBinding(2, run.sequence),
        on_change=lambda name, value: events.append((name, value)),
    )
    outcome = PydanticModelRunner(
        settings, build_model=lambda config: FunctionModel(stream_function=stream)
    ).run(
        replace(
            request(),
            request_recorder=recorder,
            persist=lambda raw: history.save_progress(2, run.sequence, raw),
        ),
        tools,
    )
    assert outcome.error is None
    assert calls == 2
    assert store.message_count(discussion.id) == 1
    notices = [value for name, value in events if name == "message.created"]
    assert len(notices) == 1
    assert notices[0]["preview_id"] == seen[0]
    handle = history.model_request_summaries(2, run.sequence)[0]
    from fora.ports.agent import ModelRequestHandle

    key = recorder.generation_key(
        ModelRequestHandle(handle.ordinal, handle.request_id), 0
    )
    preview = history.generation.preview(key)
    assert preview.status == "sent" and preview.message_id == notices[0]["id"]
    messages = ModelMessagesTypeAdapter.validate_json(outcome.messages_json)
    returns = [
        part
        for message in messages
        for part in message.parts
        if part.part_kind == "tool-return"
    ]
    assert len(returns) == 1 and returns[0].content["preview_id"] == seen[0]
    assert recorder._generation._event is None


def sse(value, event=None):
    return (
        (f"event: {event}\n" if event else "") + "data: " + json.dumps(value) + "\n\n"
    )


@pytest.mark.parametrize(
    "provider", ["openai-chat", "openai-responses", "anthropic", "google"]
)
def test_locked_provider_streams_preserve_arguments_once(
    records, monkeypatch, provider
):
    organization, history, _run, recorder, initial, _events, human, first, _second = (
        records
    )
    body = "@You streamed 😀"
    args = json.dumps(
        {"action": "send", "discussion_id": first, "body": body}, ensure_ascii=False
    )
    split = args.index("streamed")
    if provider == "openai-chat":
        chunks = [
            sse(
                {
                    "id": "chat",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "gpt-4o",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call",
                                        "type": "function",
                                        "function": {
                                            "name": "discussion",
                                            "arguments": args[:split],
                                        },
                                    }
                                ]
                            },
                            "finish_reason": None,
                        }
                    ],
                }
            ),
            sse(
                {
                    "id": "chat",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "gpt-4o",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "function": {"arguments": args[split:]},
                                    }
                                ]
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                }
            ),
            "data: [DONE]\n\n",
        ]
    elif provider == "openai-responses":
        item = {
            "type": "function_call",
            "id": "item",
            "call_id": "call",
            "name": "discussion",
            "arguments": "",
            "status": "in_progress",
        }
        values = [
            {"type": "response.output_item.added", "output_index": 0, "item": item},
            {
                "type": "response.function_call_arguments.delta",
                "item_id": "item",
                "output_index": 0,
                "delta": args[:split],
            },
            {
                "type": "response.function_call_arguments.delta",
                "item_id": "item",
                "output_index": 0,
                "delta": args[split:],
            },
            {
                "type": "response.function_call_arguments.done",
                "item_id": "item",
                "output_index": 0,
                "arguments": args,
            },
            {
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {**item, "arguments": args, "status": "completed"},
            },
            {
                "type": "response.completed",
                "response": {
                    "id": "response",
                    "object": "response",
                    "created_at": 1,
                    "model": "gpt-4o",
                    "status": "completed",
                    "output": [{**item, "arguments": args, "status": "completed"}],
                },
            },
        ]
        chunks = [
            sse({**value, "sequence_number": index}, value["type"])
            for index, value in enumerate(values)
        ]
    elif provider == "anthropic":
        values = [
            {
                "type": "message_start",
                "message": {
                    "id": "message",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-sonnet-4-5",
                    "content": [],
                    "usage": {"input_tokens": 10, "output_tokens": 1},
                    "stop_reason": None,
                    "stop_sequence": None,
                },
            },
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "tool_use",
                    "id": "call",
                    "name": "discussion",
                    "input": {},
                },
            },
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "input_json_delta", "partial_json": args[:split]},
            },
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "input_json_delta", "partial_json": args[split:]},
            },
            {"type": "content_block_stop", "index": 0},
            {
                "type": "message_delta",
                "delta": {"stop_reason": "tool_use", "stop_sequence": None},
                "usage": {"output_tokens": 8},
            },
            {"type": "message_stop"},
        ]
        chunks = [sse(value, value["type"]) for value in values]
    else:
        chunks = [
            sse(
                {
                    "candidates": [
                        {
                            "content": {
                                "role": "model",
                                "parts": [
                                    {
                                        "functionCall": {
                                            "name": "discussion",
                                            "args": json.loads(args),
                                        }
                                    }
                                ],
                            },
                            "finishReason": "STOP",
                        }
                    ],
                    "usageMetadata": {
                        "promptTokenCount": 10,
                        "candidatesTokenCount": 8,
                    },
                }
            )
        ]
    raw = "".join(chunks).encode()
    wire = []

    def respond(request):
        wire.append(request)
        response_type = (
            httpx2.Response if provider in ("anthropic", "google") else httpx.Response
        )
        return response_type(
            200, content=raw, headers={"content-type": "text/event-stream"}
        )

    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", True)

    async def consume():
        if provider == "anthropic":
            client = AsyncAnthropic(
                api_key="unused",
                max_retries=0,
                http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(respond)),
            )
            model = AnthropicModel(
                "claude-sonnet-4-5", provider=AnthropicProvider(anthropic_client=client)
            )
            close = client.close
        elif provider == "google":
            client = httpx2.AsyncClient(transport=httpx2.MockTransport(respond))
            model = GoogleModel(
                "gemini-2.5-flash",
                provider=GoogleProvider(api_key="unused", http_client=client),
            )
            close = client.aclose
        else:
            client = AsyncOpenAI(
                api_key="unused",
                max_retries=0,
                http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)),
            )
            model_type = (
                OpenAIResponsesModel
                if provider == "openai-responses"
                else OpenAIChatModel
            )
            model = model_type("gpt-4o", provider=OpenAIProvider(openai_client=client))
            close = client.close
        live = LiveModel(lambda: model, lambda: "", "key", request_recorder=recorder)
        try:
            async with (
                recorder.generation_session(),
                live.request_stream(
                    [ModelRequest(parts=[UserPromptPart("work")])],
                    None,
                    ModelRequestParameters(),
                ) as response,
            ):
                async for event in response:
                    if isinstance(
                        event, PartStartEvent | PartDeltaEvent | PartEndEvent
                    ):
                        live.generation_event(event)
            handle = live.current_request_handle
            assert handle.ordinal == initial.ordinal + 1
            key = recorder.generation_key(handle, 0)
            preview = history.generation.preview(key)
            assert preview.status == "sending"
            assert (
                history.generation.preview_text(
                    preview.preview_id, first, human, preview.revision
                ).value
                == body
            )
            content = json.loads(
                history.generation.part_text(
                    key, history.generation.part(key).revision
                ).value
            )
            assert content["tool_name"] == "discussion"
            assert (
                json.loads(content["args"])
                if isinstance(content["args"], str)
                else content["args"]
            ) == json.loads(args)
            assert len(wire) == 1
            assert organization.message_count(first) == 0
        finally:
            await close()

    asyncio.run(consume())
