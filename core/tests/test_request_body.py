from __future__ import annotations

import asyncio
import json
from dataclasses import replace

import httpx2
import pytest
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.messages import ModelRequest, UserPromptPart
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.providers import _openai_compatible, anthropic

from fora.adapters.model import probe, runner
from fora.adapters.model.config import (
    AgentModelConfig,
    ModelCatalog,
    ModelConfig,
    ProviderConfig,
    RegisteredModel,
    validate_request_body,
)
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.core.errors import DomainError
from fora.ports.agent import ModelRequestHandle
from fora.runtime.reminder import HistoryPersistenceError, TurnRequest
from fora.runtime.scheduler import _TurnRequestRecorder


def catalog(api_type="openai-chat", extra_body=None):
    return ModelCatalog(
        providers=[
            ProviderConfig(
                id="p",
                name="Provider",
                api_type=api_type,
                base_url="https://provider.invalid/v1",
                api_key="test-only-key",
                extra_body=extra_body or {},
            )
        ],
        models=[
            RegisteredModel(id="m", provider_id="p", name="Model", model="custom-model")
        ],
        default_model_id="m",
        default_thinking="high",
    )


@pytest.mark.parametrize("root", [None, [], 1, "{}", True])
def test_invalid_roots_fail_on_save_and_restore(root):
    current = catalog()
    with pytest.raises(DomainError, match="JSON object"):
        current.apply(
            {"action": "save_provider", "id": "p", "values": {"extra_body": root}}, {1}
        )
    stored = current.model_dump()
    stored["providers"][0]["extra_body"] = root
    with pytest.raises(DomainError, match="JSON object"):
        ModelCatalog.restore(stored)
    assert current.providers[0].extra_body == {}


@pytest.mark.parametrize(
    "field",
    [
        "api_key",
        "apiKey",
        "AUTHORIZATION",
        "access_token",
        "accessToken",
        "refreshToken",
        "bearer_token",
        "credentials",
        "credential",
        "password",
        "secret_key",
        "headers",
        "extra_headers",
        "extra_query",
        "baseURL",
        "httpOptions",
        "http_client",
        "timeout",
        "max_retries",
        "__proto__",
        "prototype",
        "constructor",
    ],
)
@pytest.mark.parametrize("nested", [False, True])
def test_client_fields_are_protected_at_every_level(field, nested):
    value = {field: "private-test-marker"}
    if nested:
        value = {"extension": [value]}
    with pytest.raises(DomainError) as failed:
        validate_request_body(value, "openai-chat")
    assert failed.value.code == "invalid_request_body"
    assert "private-test-marker" not in str(failed.value)


@pytest.mark.parametrize(
    "field",
    [
        "model",
        "model_name",
        "messages",
        "input",
        "prompt",
        "instructions",
        "system",
        "contents",
        "systemInstruction",
        "tools",
        "toolChoice",
        "functions",
        "function_call",
        "parallel_tool_calls",
        "stream",
        "stream_options",
        "response_format",
        "output_format",
        "text",
        "modalities",
        "audio",
        "n",
        "conversation",
        "previous_response_id",
        "store",
        "background",
        "include",
        "truncation",
        "context_management",
        "mcp_servers",
        "container",
        "cache_control",
        "cached_content",
        "prompt_cache_key",
        "prompt_cache_retention",
        "prompt_cache_options",
        "extra_body",
    ],
)
def test_protocol_fields_are_protected(field):
    with pytest.raises(DomainError, match="protected protocol"):
        validate_request_body({field: None}, "openai-chat")


def test_size_depth_unicode_and_number_boundaries():
    limit = {"x": "a" * (16384 - 8)}
    assert len(json.dumps(limit, separators=(",", ":")).encode()) == 16384
    assert validate_request_body(limit, "openai-chat") == limit
    with pytest.raises(DomainError, match="16 KiB"):
        validate_request_body({"x": limit["x"] + "a"}, "openai-chat")
    nested = {}
    for _ in range(15):
        nested = {"x": nested}
    assert validate_request_body(nested, "openai-chat") == nested
    with pytest.raises(DomainError, match="16 container"):
        validate_request_body({"x": nested}, "openai-chat")
    assert validate_request_body({"x": "你好😀", "v": None}, "openai-chat")["v"] is None
    for invalid in [
        float("nan"),
        float("inf"),
        float("-inf"),
        "\ud800",
        "\udfff",
        (1,),
    ]:
        with pytest.raises(DomainError):
            validate_request_body({"x": invalid}, "openai-chat")
    for key in ["", "9x", "a-b", "a" * 65, "你好", "\ud800"]:
        with pytest.raises(DomainError):
            validate_request_body({key: 1}, "openai-chat")


def test_updates_replace_preserve_clear_and_restore_legacy():
    current = catalog(extra_body={"extension": {"old": 1}, "remove": 2})
    updated = current.apply(
        {
            "action": "save_provider",
            "id": "p",
            "values": {"extra_body": {"extension": None}},
        },
        {1},
    )
    assert updated.providers[0].extra_body == {"extension": None}
    preserved = updated.apply(
        {"action": "save_provider", "id": "p", "values": {"name": "Renamed"}}, {1}
    )
    assert preserved.providers[0].extra_body == {"extension": None}
    cleared = preserved.apply(
        {"action": "save_provider", "id": "p", "values": {"extra_body": {}}}, {1}
    )
    assert cleared.providers[0].extra_body == {}
    for version in [1, 2]:
        stored = catalog().model_dump()
        stored["version"] = version
        stored["providers"][0].pop("extra_body")
        if version == 1:
            stored["models"][0].pop("thinking_budget_tokens")
        assert ModelCatalog.restore(stored).providers[0].extra_body == {}
    legacy = ModelCatalog.restore({"api_type": "openai-chat", "model": "m"})
    assert legacy.providers[0].extra_body == {}
    assert current.providers[0].extra_body == {"extension": {"old": 1}, "remove": 2}


def test_google_switch_requires_explicit_clear_and_restore_rejects():
    current = catalog(extra_body={"extension": 1})
    with pytest.raises(DomainError) as failed:
        current.apply(
            {"action": "save_provider", "id": "p", "values": {"api_type": "google"}},
            {1},
        )
    assert failed.value.code == "unsupported_request_body"
    cleared = current.apply(
        {
            "action": "save_provider",
            "id": "p",
            "values": {"api_type": "google", "extra_body": {}},
        },
        {1},
    )
    assert cleared.providers[0].api_type == "google"
    stored = current.model_dump()
    stored["providers"][0]["api_type"] = "google"
    with pytest.raises(DomainError):
        ModelCatalog.restore(stored)


@pytest.mark.parametrize(
    "api_type,body",
    [
        ("openai-chat", {"max_tokens": True}),
        ("openai-chat", {"max_tokens": 1, "max_completion_tokens": 2}),
        ("openai-chat", {"max_output_tokens": 1}),
        ("openai-chat", {"reasoning_effort": None}),
        ("openai-responses", {"reasoning": []}),
        ("openai-responses", {"reasoning": {"effort": 1}}),
        ("openai-responses", {"max_tokens": 1}),
        ("anthropic", {"thinking": {"type": "enabled", "budget_tokens": False}}),
        ("anthropic", {"thinking": {"type": "unknown"}}),
        ("anthropic", {"output_config": {"format": {}}}),
        ("anthropic", {"output_config": {"effort": None}}),
    ],
)
def test_known_fields_have_interface_specific_validation(api_type, body):
    with pytest.raises(DomainError):
        validate_request_body(body, api_type)


class Recorder:
    def __init__(self, fail=False):
        self.settings = []
        self.identities = []
        self.errors = []
        self.fail = fail

    def start(self, messages, parameters, settings, identity, streaming):
        if self.fail:
            raise OSError("controlled persistence failure")
        self.settings.append(json.loads(settings))
        self.identities.append(json.loads(identity))
        return ModelRequestHandle(len(self.settings), "request")

    def error(self, handle, error):
        self.errors.append(error)

    def response(self, handle, response):
        assert response

    def related(self, handle, messages):
        assert messages

    def success(self, handle):
        assert handle.ordinal > 0


WIRE_CASES = [
    ("openai-chat", "custom-model", {"reasoning_effort": "low", "max_tokens": 128}),
    ("openai-chat", "custom-model", {"max_completion_tokens": 129}),
    (
        "openai-responses",
        "gpt-5.2",
        {"reasoning": {"effort": "low"}, "max_output_tokens": 130},
    ),
    ("openai-responses", "gpt-5.2", {"reasoning": {"summary": "auto"}}),
    (
        "anthropic",
        "claude-sonnet-4-5",
        {"thinking": {"type": "disabled"}, "output_config": {}, "max_tokens": 131},
    ),
    (
        "anthropic",
        "claude-sonnet-4-5",
        {"thinking": {"type": "enabled", "budget_tokens": 1024}, "max_tokens": 9216},
    ),
    (
        "anthropic",
        "claude-sonnet-4-6",
        {"thinking": {"type": "adaptive"}, "output_config": {"effort": "low"}},
    ),
]


def transport(monkeypatch, respond):
    clients = []

    def create():
        client = httpx2.AsyncClient(transport=httpx2.MockTransport(respond))
        clients.append(client)
        return client

    monkeypatch.setattr(_openai_compatible, "create_async_httpx2_client", create)
    monkeypatch.setattr(anthropic, "create_async_httpx2_client", create)
    return clients


@pytest.mark.parametrize("api_type,model,body", WIRE_CASES)
@pytest.mark.parametrize("streaming", [False, True])
def test_sdk_final_body_precedence_and_history(
    monkeypatch, tmp_path, api_type, model, body, streaming
):
    bodies = []

    def refuse(request):
        bodies.append(json.loads(request.content))
        return httpx2.Response(
            400,
            json={
                "error": {
                    "type": "invalid_request_error",
                    "message": "controlled refusal",
                }
            },
        )

    clients = transport(monkeypatch, refuse)
    extra = {
        **body,
        "extension": {"list": [1, None, {"value": "你好"}]},
        "nullable": None,
    }
    config = ModelConfig(
        api_type,
        "https://provider.invalid/v1",
        "test-only-key",
        model,
        "high",
        extra_body=extra,
        provider_id="p",
    )
    recorded = Recorder()

    async def send():
        async with runner.build_model(config) as wrapped:
            live = runner.LiveModel(
                lambda: wrapped,
                lambda: "",
                "cache",
                request_recorder=recorded,
                model_snapshot={
                    "provider_id": config.provider_id,
                    "api_type": api_type,
                },
            )
            with pytest.raises(ModelHTTPError, match="controlled refusal"):
                if streaming:
                    async with live.request_stream(
                        [ModelRequest(parts=[UserPromptPart("Hello")])],
                        wrapped.settings,
                        ModelRequestParameters(),
                    ):
                        pytest.fail("refused stream entered")
                else:
                    await live.request(
                        [ModelRequest(parts=[UserPromptPart("Hello")])],
                        wrapped.settings,
                        ModelRequestParameters(),
                    )

    asyncio.run(send())
    assert len(bodies) == 1
    for key, value in extra.items():
        assert bodies[0][key] == value
    assert bodies[0]["stream"] is streaming
    if api_type == "openai-chat" and "max_tokens" in body:
        assert "max_completion_tokens" not in bodies[0]
    if api_type == "openai-responses" and "effort" not in body["reasoning"]:
        assert "openai_reasoning_effort" not in recorded.settings[0]
    assert recorded.settings[0]["extra_body"] == extra
    assert recorded.identities[0]["provider_id"] == "p"
    assert recorded.identities[0]["api_type"] == api_type
    assert len(recorded.errors) == 1
    assert all(client.is_closed for client in clients)
    (tmp_path / "http-body.json").write_text(
        json.dumps(bodies[0], ensure_ascii=False), encoding="utf-8"
    )


def test_probe_uses_saved_body_and_explicit_limit_and_closes(monkeypatch):
    bodies = []

    def refuse(request):
        bodies.append(json.loads(request.content))
        return httpx2.Response(400, json={"error": {"message": "controlled refusal"}})

    clients = transport(monkeypatch, refuse)
    current = catalog(extra_body={"max_tokens": 123, "extension": None})
    for values in [{"model_id": "m"}, {"provider_id": "p", "model": "custom-model"}]:
        with pytest.raises(DomainError, match="controlled refusal"):
            probe.try_model(values, current.model_dump())
        assert bodies[-1]["max_tokens"] == 123
        assert "max_completion_tokens" not in bodies[-1]
        assert bodies[-1]["extension"] is None
    assert len(bodies) == 2
    assert all(client.is_closed for client in clients)


def test_persistence_failure_and_google_fail_before_network(monkeypatch):
    bodies = []

    def refuse(request):
        bodies.append(request)
        raise AssertionError("Network must not start")

    clients = transport(monkeypatch, refuse)
    config = catalog(extra_body={"extension": 1}).resolve()

    async def send():
        async with runner.build_model(config) as wrapped:
            live = runner.LiveModel(
                lambda: wrapped,
                lambda: "",
                "cache",
                request_recorder=Recorder(fail=True),
            )
            with pytest.raises(HistoryPersistenceError):
                await live.request(
                    [ModelRequest(parts=[UserPromptPart("Hello")])],
                    wrapped.settings,
                    ModelRequestParameters(),
                )

    asyncio.run(send())
    with pytest.raises(DomainError):
        runner.build_model(replace(config, api_type="google"))
    with pytest.raises(DomainError):
        runner.build_model(
            replace(
                config,
                api_type="anthropic",
                model="claude-opus-4-7",
                extra_body={"temperature": 0.5},
            )
        )
    assert bodies == []
    assert all(client.is_closed for client in clients)


def test_shared_provider_agents_and_snapshot_containers():
    current = catalog(extra_body={"extension": [1]})
    current.providers.append(
        ProviderConfig(
            id="other",
            name="Other",
            api_type="openai-chat",
            base_url="https://other.invalid",
            api_key="test-only-key",
        )
    )
    current.models.append(
        RegisteredModel(
            id="other-model", provider_id="other", name="Other", model="other"
        )
    )
    current.agent_configs["3"] = AgentModelConfig(model_id="other-model")
    first = current.resolve(1)
    second = current.resolve(2)
    assert first.extra_body == second.extra_body == {"extension": [1]}
    assert current.resolve(3).extra_body == {}
    first.extra_body["extension"].append(2)
    assert second.extra_body == {"extension": [1]}
    updated = current.apply(
        {
            "action": "save_provider",
            "id": "p",
            "values": {"extra_body": {"extension": [3]}},
        },
        {1, 2, 3},
    )
    assert second.extra_body == {"extension": [1]}
    assert updated.resolve(2).extra_body == {"extension": [3]}


def test_sqlite_update_failure_preserves_complete_settings(tmp_path):
    base = SqliteStore(tmp_path / "config.sqlite3")
    settings = SqliteAgentStore(base._db)
    try:
        settings.set_settings(
            "model", catalog(extra_body={"extension": 1}).model_dump()
        )
        before = settings.get_settings("model")
        with pytest.raises(DomainError):
            settings.update_settings(
                "model",
                {
                    "action": "save_provider",
                    "id": "p",
                    "values": {
                        "name": "Changed",
                        "api_key": "new-test-key",
                        "extra_body": {"messages": []},
                    },
                },
            )
        assert settings.get_settings("model") == before
        with base._db:
            base._db.execute(
                "CREATE TRIGGER refuse_settings BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'controlled refusal'); END"
            )
        with pytest.raises(Exception, match="controlled refusal"):
            settings.update_settings(
                "model",
                {
                    "action": "save_provider",
                    "id": "p",
                    "values": {"extra_body": {"extension": 2}},
                },
            )
        assert settings.get_settings("model") == before
    finally:
        base.close()


@pytest.mark.parametrize("api_type", ["openai-chat", "openai-responses", "anthropic"])
@pytest.mark.parametrize("streaming", [False, True])
def test_cancellation_preserves_real_sqlite_request_and_releases_client(
    monkeypatch, tmp_path, api_type, streaming
):
    base = SqliteStore(tmp_path / "cancel.sqlite3")
    settings = SqliteAgentStore(base._db)
    run = settings.start_run(1)
    bodies = []

    async def send():
        entered = asyncio.Event()

        async def respond(request):
            bodies.append(json.loads(request.content))
            entered.set()
            await asyncio.Event().wait()
            raise AssertionError("Cancelled request continued")

        clients = transport(monkeypatch, respond)
        config = catalog(api_type, {"extension": {"version": 1}}).resolve()
        async with runner.build_model(config) as wrapped:
            recorder = _TurnRequestRecorder(settings, run, 1, lambda event: None)
            live = runner.LiveModel(
                lambda: wrapped,
                lambda: "",
                "cache",
                request_recorder=recorder,
                model_snapshot={"provider_id": config.provider_id},
            )

            async def request():
                messages = [ModelRequest(parts=[UserPromptPart("Hello")])]
                if streaming:
                    async with live.request_stream(
                        messages, wrapped.settings, ModelRequestParameters()
                    ):
                        pytest.fail("Cancelled stream entered")
                else:
                    await live.request(
                        messages, wrapped.settings, ModelRequestParameters()
                    )

            task = asyncio.create_task(request())
            await asyncio.wait_for(entered.wait(), 5)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert all(client.is_closed for client in clients)

    try:
        asyncio.run(send())
        saved = json.loads(
            settings.model_request_field(1, run.sequence, 1, "settings", 0, 16384).value
        )
        identity = json.loads(
            settings.model_request_field(1, run.sequence, 1, "model", 0, 16384).value
        )
        assert saved["extra_body"] == {"extension": {"version": 1}}
        assert bodies[0]["extension"] == saved["extra_body"]["extension"]
        assert identity["provider_id"] == "p"
        assert len(bodies) == 1
        assert settings.model_request_summary(1, run.sequence, 1).error is not None
    finally:
        base.close()


@pytest.mark.parametrize("api_type", ["openai-chat", "openai-responses", "anthropic"])
def test_runner_same_turn_snapshot_next_turn_and_provider_isolation(
    monkeypatch, tmp_path, api_type
):
    bodies = []
    base = SqliteStore(tmp_path / "turns.sqlite3")
    settings = SqliteAgentStore(base._db)
    current = catalog(api_type, {"extension": {"version": 1}})
    current.default_thinking = "default"
    current.providers.append(
        ProviderConfig(
            id="other",
            name="Other",
            api_type=api_type,
            base_url="https://other.invalid/v1",
            api_key="test-only-key",
        )
    )
    current.models.append(
        RegisteredModel(
            id="other-model", provider_id="other", name="Other", model="other"
        )
    )
    settings.set_settings("model", current.model_dump())
    first_agent = settings.create_agent_with_model("First", None)["id"]
    second_agent = settings.create_agent_with_model("Second", None)["id"]
    other_agent = settings.create_agent_with_model(
        "Other", {"model_id": "other-model"}
    )["id"]

    def respond(request):
        body = json.loads(request.content)
        bodies.append(body)
        first = len(bodies) == 1
        arguments = {"action": "list_members"}
        if api_type == "anthropic":
            content = (
                [
                    {
                        "type": "tool_use",
                        "id": "call-1",
                        "name": "organization",
                        "input": arguments,
                    }
                ]
                if first
                else [{"type": "text", "text": "OK"}]
            )
            response = {
                "id": "message",
                "type": "message",
                "role": "assistant",
                "model": body["model"],
                "content": content,
                "stop_reason": "tool_use" if first else "end_turn",
                "usage": {"input_tokens": 10, "output_tokens": 2},
            }
        elif api_type == "openai-responses":
            output = (
                [
                    {
                        "type": "function_call",
                        "id": "tool",
                        "call_id": "call-1",
                        "name": "organization",
                        "arguments": json.dumps(arguments),
                    }
                ]
                if first
                else [
                    {
                        "type": "message",
                        "id": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [
                            {"type": "output_text", "text": "OK", "annotations": []}
                        ],
                    }
                ]
            )
            response = {
                "id": "response",
                "object": "response",
                "status": "completed",
                "created_at": 1,
                "model": body["model"],
                "output": output,
                "usage": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12},
            }
        else:
            message = (
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {
                                "name": "organization",
                                "arguments": json.dumps(arguments),
                            },
                        }
                    ],
                }
                if first
                else {"role": "assistant", "content": "OK"}
            )
            response = {
                "id": "response",
                "object": "chat.completion",
                "created": 1,
                "model": body["model"],
                "choices": [
                    {
                        "index": 0,
                        "message": message,
                        "finish_reason": "tool_calls" if first else "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 2,
                    "total_tokens": 12,
                },
            }
        return httpx2.Response(200, json=response)

    clients = transport(monkeypatch, respond)

    class Tools:
        def list_members(self):
            settings.update_settings(
                "model",
                {
                    "action": "save_provider",
                    "id": "p",
                    "values": {"extra_body": {"extension": {"version": 2}}},
                },
            )
            return []

    model_runner = runner.PydanticModelRunner(settings)
    recorded = []
    try:
        for index, agent_id in enumerate(
            [first_agent, first_agent, second_agent, other_agent]
        ):
            recorder = Recorder()
            recorded.append(recorder)
            result = model_runner.run(
                TurnRequest(
                    agent_id,
                    index + 1,
                    "Agent",
                    "Reply OK",
                    None,
                    "[]",
                    "resident",
                    lambda: "",
                    lambda: "",
                    lambda value: None,
                    request_recorder=recorder,
                ),
                Tools(),
            )
            assert result.error is None
        assert len(bodies) == 5
        assert [body.get("extension") for body in bodies] == [
            {"version": 1},
            {"version": 1},
            {"version": 2},
            {"version": 2},
            None,
        ]
        assert (
            recorded[0].settings[0]["extra_body"]
            == recorded[0].settings[1]["extra_body"]
            == {"extension": {"version": 1}}
        )
        assert recorded[1].settings[0]["extra_body"] == {"extension": {"version": 2}}
        assert recorded[0].identities[0]["provider_id"] == "p"
        assert recorded[3].identities[0]["provider_id"] == "other"
        assert all(client.is_closed for client in clients)
        (tmp_path / "turn-http-bodies.json").write_text(
            json.dumps(bodies), encoding="utf-8"
        )
    finally:
        base.close()
