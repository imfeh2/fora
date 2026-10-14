import json
from dataclasses import replace

import pytest
from model_fixtures import GenerationRecorderStub
from pydantic_ai import ModelMessagesTypeAdapter
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import FunctionModel
from test_runner import FakeSettings, flattened, model_values, request

from fora.adapters.model.context_sources import ContextSources
from fora.adapters.model.runner import PydanticModelRunner
from fora.ports.agent import ModelRequestHandle


class Recorder(GenerationRecorderStub):
    def __init__(self):
        self.inputs = []
        self.parameters = []
        self.related_results = []
        self.errors = []

    def start(self, messages, parameters, settings, model, streaming):
        self.inputs.append(
            [ModelMessagesTypeAdapter.validate_json(raw)[0] for raw in messages]
        )
        self.parameters.append(json.loads(parameters))
        return ModelRequestHandle(len(self.inputs), str(len(self.inputs)))

    def response(self, handle, response):
        pass

    def related(self, handle, messages):
        self.related_results.append(
            [ModelMessagesTypeAdapter.validate_json(raw)[0] for raw in messages]
        )

    def error(self, handle, error):
        self.errors.append((handle, error))

    def success(self, handle):
        pass


def sources(messages):
    result = []
    for message in messages:
        if not isinstance(message, ModelRequest):
            continue
        marker = (message.metadata or {}).get("fora", {}).get("context_sources")
        if marker is None:
            continue
        assert marker["version"] == 1
        for source in marker["parts"]:
            part = message.parts[source["part_index"]]
            assert isinstance(part, UserPromptPart)
            result.append((source, part))
    return result


def test_snapshot_records_actual_part_order_and_restores_original_metadata():
    prompts = [UserPromptPart("same"), UserPromptPart("same")]
    tracker = ContextSources(2, 1)
    tracker.mark(prompts[0], "session_context")
    tracker.mark(prompts[1], "reminder")
    message = ModelRequest(
        parts=[ToolReturnPart("run", "done", "run"), prompts[1], prompts[0]],
        metadata={"fora": {"environment": "A"}, "__pydantic_ai__": {"other": 7}},
    )
    snapshot = tracker.snapshot([message])
    saved = sources(snapshot)
    assert [(source["part_index"], source["kind"]) for source, part in saved] == [
        (1, "reminder"),
        (2, "session_context"),
    ]
    assert saved[0][0]["source_id"] != saved[1][0]["source_id"]
    assert message.metadata == {
        "fora": {"environment": "A"},
        "__pydantic_ai__": {"other": 7},
    }
    assert snapshot[0].parts is message.parts
    raw = ModelMessagesTypeAdapter.dump_json(snapshot)
    decoded = ModelMessagesTypeAdapter.validate_json(raw)
    following = ContextSources(2, 2)
    restored = following.restore(decoded)
    assert restored[0].metadata == message.metadata
    assert following.snapshot(restored) == decoded
    assert all(source["sequence"] == 1 for source, part in sources(decoded))


@pytest.mark.parametrize("metadata", [None, {}, {"fora": {}}, {"other": "value"}])
def test_snapshot_and_restore_preserve_metadata_shape(metadata):
    prompt = UserPromptPart("content")
    tracker = ContextSources(2, 1)
    tracker.mark(prompt, "reminder")
    original = ModelRequest(parts=[prompt], metadata=metadata)
    saved = tracker.snapshot([original])
    assert ContextSources(2, 2).restore(saved) == [original]
    assert saved[0].metadata is not metadata


@pytest.mark.parametrize(
    "field,value",
    [
        ("part_index", -1),
        ("part_index", True),
        ("agent_id", 3),
        ("sequence", 2),
        ("sequence", True),
        ("source_id", ""),
    ],
)
def test_invalid_part_identity_is_not_restored(field, value):
    prompt = UserPromptPart("original")
    tracker = ContextSources(2, 1)
    tracker.mark(prompt, "reminder")
    saved = tracker.snapshot([ModelRequest(parts=[prompt])])[0]
    marker = saved.metadata["fora"]["context_sources"]
    marker["parts"][0][field] = value
    following = ContextSources(2, 1)
    assert following.restore([saved]) == [saved]
    assert following.snapshot([saved]) == [saved]


@pytest.mark.parametrize(
    "change",
    [
        {"version": 2},
        {"version": True},
        {"parts": [{"part_index": 5}]},
        {"parts": [{"part_index": 0, "kind": "unknown"}]},
    ],
)
def test_invalid_sources_preserve_readable_history_without_assigning_identity(change):
    prompt = UserPromptPart("saved original")
    tracker = ContextSources(2, 1)
    tracker.mark(prompt, "reminder")
    saved = tracker.snapshot([ModelRequest(parts=[prompt])])[0]
    saved.metadata["fora"]["context_sources"].update(change)
    next_tracker = ContextSources(2, 2)
    assert next_tracker.restore([saved]) == [saved]
    assert next_tracker.snapshot([saved]) == [saved]


@pytest.mark.parametrize("fail", [False, True])
def test_real_sdk_merges_and_sorts_sources_across_requests_and_activity_decode(fail):
    settings = FakeSettings()
    settings.set_settings("model", model_values("local"))
    recorder = Recorder()
    persisted = []
    provider_inputs = []
    environment = "environment A"
    nudges = iter(["temporary one", "temporary two"])

    def respond(messages, info):
        provider_inputs.append(
            ModelMessagesTypeAdapter.validate_json(
                ModelMessagesTypeAdapter.dump_json(messages)
            )
        )
        assert not sources(messages)
        if len(provider_inputs) == 1:
            assert len(messages) == 1
            assert messages[0].run_id is None
            return ModelResponse(
                parts=[ToolCallPart("organization", {"action": "list_members"}, "list")]
            )
        if fail:
            raise RuntimeError("controlled failure")
        return ModelResponse(parts=[TextPart("finished")])

    class Tools:
        def list_members(self):
            nonlocal environment
            environment = "environment B"
            return []

    original = replace(
        request(),
        environment=lambda: environment,
        ephemeral=lambda: next(nudges),
        persist=persisted.append,
        request_recorder=recorder,
        agents_instructions="saved instructions\n ",
    )
    outcome = PydanticModelRunner(
        settings, build_model=lambda config: FunctionModel(respond)
    ).run(original, Tools())
    assert (outcome.error is not None) == fail
    assert len(recorder.inputs) == len(provider_inputs) == 2
    assert [source["kind"] for source, part in sources(recorder.inputs[0])] == [
        "session_context",
        "reminder",
        "ephemeral",
    ]
    assert [source["kind"] for source, part in sources(recorder.inputs[1])] == [
        "session_context",
        "reminder",
        "environment",
        "ephemeral",
    ]
    for recorded, provider in zip(recorder.inputs, provider_inputs, strict=True):
        assert ContextSources(2, 1).restore(recorded) == provider
        assert flattened(recorded) == flattened(provider)
    initial = ModelMessagesTypeAdapter.validate_json(persisted[0])
    assert [source["kind"] for source, part in sources(initial)] == ["session_context"]
    saved = ModelMessagesTypeAdapter.validate_json(outcome.messages_json)
    durable_sources = sources(saved)
    assert [source["kind"] for source, part in durable_sources] == [
        "session_context",
        "reminder",
        "environment",
    ]
    original_ids = {source["source_id"] for source, part in durable_sources}
    assert len(original_ids) == 3
    for raw in persisted:
        assert "temporary" not in raw
        assert all(
            source["kind"] != "ephemeral"
            for source, part in sources(ModelMessagesTypeAdapter.validate_json(raw))
        )
    assert {
        source["source_id"] for source, part in sources(recorder.inputs[0])
    } & original_ids == {source["source_id"] for source, part in durable_sources[:2]}
    environment_position = next(
        (message, source)
        for message in recorder.inputs[1]
        for source, part in sources([message])
        if source["kind"] == "environment"
    )
    message, environment_source = environment_position
    assert isinstance(message.parts[0], ToolReturnPart)
    assert environment_source["part_index"] == 1
    assert recorder.related_results
    assert sources(recorder.related_results[0])[0][0]["kind"] == "environment"
    following_recorder = Recorder()
    following = PydanticModelRunner(
        settings,
        build_model=lambda config: FunctionModel(
            lambda messages, info: ModelResponse(parts=[TextPart("next")])
        ),
    ).run(
        replace(
            original,
            sequence=2,
            history_json=outcome.messages_json,
            prompt=original.prompt,
            ephemeral=lambda: "",
            request_recorder=following_recorder,
            persist=lambda raw: None,
        ),
        None,
    )
    assert following.error is None
    inherited = sources(following_recorder.inputs[0])
    assert {
        source["source_id"] for source, part in inherited if source["sequence"] == 1
    } == original_ids
    assert [
        source["kind"] for source, part in inherited if source["sequence"] == 2
    ] == ["reminder"]
    assert inherited[-1][0]["source_id"] not in original_ids


@pytest.mark.parametrize("instructions", [None, "saved instructions\n "])
def test_source_tracking_preserves_model_input_semantics(monkeypatch, instructions):
    settings = FakeSettings()
    settings.set_settings("model", model_values("local"))

    def execute():
        recorder = Recorder()
        received = []
        checkpoints = []
        environment = "environment A"

        def respond(messages, info):
            received.append(flattened(messages))
            if len(received) == 1:
                return ModelResponse(
                    parts=[
                        ToolCallPart("organization", {"action": "list_members"}, "list")
                    ]
                )
            return ModelResponse(parts=[TextPart("complete")])

        class Tools:
            def list_members(self):
                nonlocal environment
                environment = "environment B"
                return []

        outcome = PydanticModelRunner(
            settings, build_model=lambda config: FunctionModel(respond)
        ).run(
            replace(
                request(),
                agents_instructions=instructions,
                ephemeral=lambda: "temporary",
                environment=lambda: environment,
                request_recorder=recorder,
                persist=lambda raw: checkpoints.append(
                    flattened(ModelMessagesTypeAdapter.validate_json(raw))
                ),
            ),
            Tools(),
        )
        assert outcome.error is None
        return received, checkpoints, recorder.parameters, outcome.usage_json

    tracked = execute()
    with monkeypatch.context() as untracked:
        untracked.setattr(ContextSources, "mark", lambda *args: None)
        baseline = execute()
    assert tracked == baseline


def test_preparation_prompt_has_an_independent_source_without_a_reminder():
    settings = FakeSettings()
    settings.set_settings("model", model_values("local"))
    recorder = Recorder()
    outcome = PydanticModelRunner(
        settings,
        build_model=lambda config: FunctionModel(
            lambda messages, info: ModelResponse(parts=[TextPart("prepared")])
        ),
    ).run(
        replace(request(), reminder=None, prompt="prepare", request_recorder=recorder),
        None,
    )
    assert outcome.error is None
    assert [source["kind"] for source, part in sources(recorder.inputs[0])] == [
        "session_context",
        "preparation",
    ]
