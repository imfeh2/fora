from __future__ import annotations

import asyncio
import json
import threading
from dataclasses import FrozenInstanceError, replace

import pytest
from model_fixtures import GenerationRecorderStub
from pydantic_ai import BinaryContent, ModelMessagesTypeAdapter, ToolReturn
from pydantic_ai.exceptions import ToolFailed
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.usage import RequestUsage

from fora.adapters.model.runner import PydanticModelRunner
from fora.ports.agent import AgentRun, ModelRequestHandle
from fora.ports.live import LiveRequestCoverage, LiveTool
from fora.runtime.live import LiveSnapshots
from fora.runtime.reminder import TurnRequest


def run_record(agent_id=2, sequence=1):
    return AgentRun(
        agent_id,
        sequence,
        "run",
        "running",
        "2026-10-11T00:00:00Z",
        None,
        "[]",
        None,
        None,
    )


def test_snapshots_keep_read_versions_and_release_saved_results():
    emitted = []
    snapshots = LiveSnapshots(lambda name, payload: emitted.append((name, payload)))
    observer = snapshots.begin(run_record())
    handle = ModelRequestHandle(1, "request")
    observer.started(handle, "start", "{}")
    observer.response(
        handle,
        '{"input_tokens":0}',
        (LiveTool(0, "same", "a"), LiveTool(1, "same", "b")),
    )
    previous = snapshots.capture()[0]
    observer.tool(
        handle,
        replace(
            previous.requests[0].tools[0],
            status="completed",
            result_json="[]",
            content_version="v1",
        ),
    )
    assert previous.requests[0].tools[0].status == "queued"
    assert snapshots.capture()[0].requests[0].tools[1].status == "queued"
    observer.saved((LiveRequestCoverage(handle, tools=((0, "v1"),)),))
    current = snapshots.capture()[0]
    assert current.requests[0].tools[0].saved
    assert current.requests[0].tools[0].result_json is None
    assert not current.requests[0].tools[1].saved
    assert current.live_revision == 4
    with pytest.raises(FrozenInstanceError):
        current.status = "failed"
    snapshots.remove(2, 1)
    assert snapshots.capture() == ()
    assert previous.requests[0].usage_json == '{"input_tokens":0}'
    assert emitted[-1][1]["saved"] is True


def test_usage_observation_preserves_short_records_after_saving_and_failure():
    snapshots = LiveSnapshots(lambda name, payload: None)
    observer = snapshots.begin(run_record())
    first = ModelRequestHandle(1, "first")
    second = ModelRequestHandle(2, "second")
    observer.started(first, "2026-10-11T00:00:01Z", '{"model":"first"}')
    observer.response(
        first,
        '{"input_tokens":10,"output_tokens":0,"cost":"0.01"}',
        (),
        '[{"kind":"response"}]',
        "response-first",
        '{"cost_source":"genai-prices","currency":"USD"}',
        "2026-10-11T00:00:02Z",
    )
    previous = snapshots.usage_capture()
    observer.saved((LiveRequestCoverage(first, "response-first"),))
    observer.started(second, "2026-10-11T00:00:03Z", '{"model":"second"}')
    observer.response(
        second,
        '{"input_tokens":20,"output_tokens":1}',
        (),
        '[{"kind":"response"}]',
        "response-second",
        '{"cost_source":"sdk_response","currency":"USD"}',
        "2026-10-11T00:00:04Z",
    )
    snapshots.finish(2, 1, "disk unavailable")
    retained = snapshots.usage_capture(2)
    requests = retained.turns[0].requests
    assert len(requests) == 2
    assert requests[0].saved is True
    assert requests[1].saved is False
    assert requests[0].usage_json == previous.turns[0].requests[0].usage_json
    assert requests[0].metadata_json == previous.turns[0].requests[0].metadata_json
    assert requests[0].completed_at == "2026-10-11T00:00:02Z"
    assert retained.turns[0].status == "unsaved"
    assert previous.turns[0].requests[0].saved is False
    assert retained.versions > previous.versions
    assert snapshots.capture()[0].requests[0].response_json is None
    snapshots.begin(run_record(sequence=2))
    assert snapshots.usage_capture().turns[0].requests == ()
    assert len(retained.turns[0].requests) == 2
    snapshots.close()
    assert snapshots.usage_capture().turns == ()


def test_snapshot_lifecycle_replaces_failed_turn_and_ignores_old_observer():
    snapshots = LiveSnapshots(lambda name, payload: None)
    old = snapshots.begin(run_record())
    with pytest.raises(RuntimeError, match="current Turn"):
        snapshots.begin(run_record(sequence=2))
    snapshots.failed(2, 1, "disk unavailable")
    snapshots.begin(run_record(sequence=2))
    old.started(ModelRequestHandle(1, "old"), "start", "{}")
    assert snapshots.capture()[0].requests == ()
    assert snapshots.capture()[0].sequence == 2
    snapshots.close()
    assert snapshots.capture() == ()
    with pytest.raises(RuntimeError, match="closed"):
        snapshots.begin(run_record())


def test_snapshot_notifications_are_outside_the_lock_and_agents_are_isolated():
    captures = []
    snapshots = LiveSnapshots(
        lambda name, payload: captures.append(snapshots.capture())
    )
    first = snapshots.begin(run_record())
    snapshots.begin(run_record(agent_id=3))
    first.started(ModelRequestHandle(1, "a"), "start", "{}")
    assert len(captures[-1]) == 2
    snapshots.remove(2, saved=False)
    assert [turn.agent_id for turn in snapshots.capture()] == [3]
    assert (
        LiveSnapshots(lambda name, payload: None).runtime_epoch
        != snapshots.runtime_epoch
    )


class Settings:
    def get_settings(self, section):
        if section == "model":
            return {
                "api_type": "openai-chat",
                "base_url": "https://example.invalid/v1",
                "api_key": "unused",
                "model": "test",
            }
        return None


class Recorder(GenerationRecorderStub):
    def __init__(self, snapshots):
        self.snapshots = snapshots
        self.requests = 0
        self.responses = []
        self.related_messages = []
        self.completed = []

    def start(
        self, messages_json, parameters_json, settings_json, model_json, streaming
    ):
        assert streaming
        self.requests += 1
        return ModelRequestHandle(self.requests, f"request-{self.requests}")

    def response(self, handle, response_json):
        live = self.snapshots.capture()[0]
        assert live.requests[-1].usage_json is not None
        self.responses.extend(response_json)

    def related(self, handle, messages_json):
        self.related_messages.extend(messages_json)

    def success(self, handle):
        self.completed.append(handle)

    def error(self, handle, error):
        raise AssertionError(error)


def make_request(observer, recorder):
    return TurnRequest(
        2,
        1,
        "Agent",
        "Work",
        None,
        "[]",
        "",
        lambda: "",
        lambda: "",
        lambda messages: None,
        request_recorder=recorder,
        live_observer=observer,
    )


@pytest.mark.parametrize("sequential", [False, True])
def test_locked_sdk_tool_results_are_observed_once_before_the_next_request(sequential):
    snapshots_seen = []
    release = threading.Event()

    def emit(name, payload):
        snapshot = snapshots.capture()[0]
        snapshots_seen.append(snapshot)
        if snapshot.requests and any(
            tool.status == "completed" and tool.tool_name == "short"
            for tool in snapshot.requests[0].tools
        ):
            release.set()

    snapshots = LiveSnapshots(emit)
    observer = snapshots.begin(run_record())
    recorder = Recorder(snapshots)
    calls = []

    def respond(messages, info):
        if recorder.requests == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart("short", {}, tool_call_id="short"),
                    ToolCallPart("long", {}, tool_call_id="long"),
                ],
                usage=RequestUsage(input_tokens=10, output_tokens=2),
            )
        return ModelResponse(
            parts=[TextPart("done")],
            usage=RequestUsage(input_tokens=20, output_tokens=3),
        )

    runner = PydanticModelRunner(
        Settings(), build_model=lambda config: FunctionModel(respond)
    )

    @runner._agent.tool_plain(sequential=sequential)
    async def short() -> str:
        calls.append("short")
        return "short result"

    @runner._agent.tool_plain(sequential=sequential)
    async def long() -> str:
        calls.append("long")
        assert await asyncio.to_thread(release.wait, 2)
        return "long result"

    outcome = runner.run(make_request(observer, recorder), None)
    assert outcome.error is None
    assert calls.count("short") == calls.count("long") == 1
    assert recorder.requests == 2
    assert len(recorder.completed) == 2
    observed = [
        snapshot.requests[0]
        for snapshot in snapshots_seen
        if snapshot.requests and snapshot.requests[0].tools
    ]
    assert any(
        request.tools[0].status == "completed"
        and request.tools[1].status in ("queued", "running")
        and not request.tools[0].saved
        for request in observed
    )
    assert (
        json.loads(snapshots.capture()[0].requests[0].usage_json)["input_tokens"] == 10
    )
    linked = ModelMessagesTypeAdapter.validate_json(recorder.related_messages[0])[0]
    observations = linked.metadata["fora"]["tool_observations"]
    assert [item["part_index"] for item in observations] == [0, 1]
    assert all(
        item["started_at"] and item["completed_at"] and item["status"] == "completed"
        for item in observations
    )
    assert [part.content for part in linked.parts] == ["short result", "long result"]


@pytest.mark.parametrize("invalid", [False, True])
def test_sdk_failure_and_validation_keep_true_started_times(invalid):
    seen = []
    snapshots = LiveSnapshots(lambda name, payload: seen.append(snapshots.capture()[0]))
    observer = snapshots.begin(run_record())
    recorder = Recorder(snapshots)
    calls = []

    def respond(messages, info):
        if recorder.requests == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "failure",
                        {"value": "invalid" if invalid else 1},
                        tool_call_id="failure",
                    )
                ]
            )
        return ModelResponse(parts=[TextPart("done")])

    runner = PydanticModelRunner(
        Settings(), build_model=lambda config: FunctionModel(respond)
    )

    @runner._agent.tool_plain
    def failure(value: int) -> str:
        calls.append(value)
        raise ToolFailed("failure")

    outcome = runner.run(make_request(observer, recorder), None)
    assert outcome.error is None
    assert calls == ([] if invalid else [1])
    failed = next(
        snapshot.requests[0].tools[0]
        for snapshot in seen
        if snapshot.requests
        and snapshot.requests[0].tools
        and snapshot.requests[0].tools[0].status == "failed"
    )
    assert (failed.started_at is None) is invalid
    assert failed.completed_at is not None
    assert failed.result_json is not None


@pytest.mark.parametrize("same_name", [False, True])
@pytest.mark.parametrize("sequential", [False, True])
def test_duplicate_ids_reject_the_entire_batch_before_any_handler(
    same_name, sequential
):
    snapshots = LiveSnapshots(lambda name, payload: None)
    observer = snapshots.begin(run_record())

    class FailureRecorder(Recorder):
        def __init__(self, snapshots):
            super().__init__(snapshots)
            self.failures = []

        def error(self, handle, error):
            self.failures.append((handle, error))

    recorder = FailureRecorder(snapshots)
    calls = []
    runner = PydanticModelRunner(
        Settings(),
        build_model=lambda config: FunctionModel(
            lambda messages, info: ModelResponse(
                parts=[
                    TextPart("known response"),
                    ToolCallPart(
                        "first", {"value": "private argument"}, tool_call_id="shared"
                    ),
                    ToolCallPart(
                        "first" if same_name else "second",
                        {"value": "private argument"},
                        tool_call_id="shared",
                    ),
                    ToolCallPart("side_effect", {}, tool_call_id="unique"),
                ],
                usage=RequestUsage(input_tokens=10, output_tokens=3),
            )
        ),
    )

    @runner._agent.tool_plain(sequential=sequential)
    def first(value: str) -> str:
        calls.append("first")
        return value

    @runner._agent.tool_plain(sequential=sequential)
    def second(value: str) -> str:
        calls.append("second")
        return value

    @runner._agent.tool_plain(sequential=sequential)
    def side_effect() -> str:
        calls.append("side_effect")
        return "completed"

    outcome = runner.run(make_request(observer, recorder), None)
    assert outcome.error.startswith("UnexpectedModelBehavior: Duplicate tool_call_id")
    assert "private argument" not in outcome.error
    assert "request-1" in outcome.error and "part_indexes=[1, 2]" in outcome.error
    assert calls == []
    assert recorder.requests == 1
    assert len(recorder.failures) == 1
    assert recorder.completed == []
    original = ModelMessagesTypeAdapter.validate_json(recorder.responses[0])[0]
    assert [
        part.tool_call_id for part in original.parts if isinstance(part, ToolCallPart)
    ] == ["shared", "shared", "unique"]
    assert original.usage.input_tokens == 10
    tools = snapshots.capture()[0].requests[0].tools
    assert [tool.part_index for tool in tools] == [1, 2, 3]
    assert all(
        tool.status == "cancelled"
        and tool.started_at is None
        and tool.result_json is None
        for tool in tools
    )
    final = ModelMessagesTypeAdapter.validate_json(outcome.messages_json)[-1]
    assert len(final.parts) == 3
    assert all(
        part.outcome == "interrupted" and "No tool was started" in part.content
        for part in final.parts
    )
    runner.validate_history(outcome.messages_json)


@pytest.mark.parametrize("sequential", [False, True])
def test_unique_ids_and_reused_ids_in_other_requests_execute_once(sequential):
    snapshots = LiveSnapshots(lambda name, payload: None)
    observer = snapshots.begin(run_record())
    recorder = Recorder(snapshots)
    calls = []

    def respond(messages, info):
        if recorder.requests == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart("first", {"value": 1}, tool_call_id="shared"),
                    ToolCallPart("first", {"value": 2}, tool_call_id="other"),
                ]
            )
        if recorder.requests == 2:
            return ModelResponse(
                parts=[ToolCallPart("first", {"value": 3}, tool_call_id="shared")]
            )
        return ModelResponse(parts=[TextPart("done")])

    runner = PydanticModelRunner(
        Settings(), build_model=lambda config: FunctionModel(respond)
    )

    @runner._agent.tool_plain(sequential=sequential)
    def first(value: int) -> str:
        calls.append(value)
        return str(value)

    outcome = runner.run(make_request(observer, recorder), None)
    assert outcome.error is None
    assert sorted(calls) == [1, 2, 3]
    assert recorder.requests == 3
    turn = snapshots.capture()[0]
    assert [tool.tool_call_id for tool in turn.requests[0].tools] == ["shared", "other"]
    assert [tool.tool_call_id for tool in turn.requests[1].tools] == ["shared"]
    assert all(
        tool.status == "completed" and tool.saved
        for request in turn.requests
        for tool in request.tools
    )


def test_saved_coverage_checks_request_identity_parts_and_content_versions():
    seen = []
    snapshots = LiveSnapshots(lambda name, payload: seen.extend(snapshots.capture()))
    observer = snapshots.begin(run_record())
    recorder = Recorder(snapshots)

    def respond(messages, info):
        if recorder.requests == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart("image", {}, tool_call_id="image"),
                    ToolCallPart("text", {}, tool_call_id="text"),
                ],
                usage=RequestUsage(input_tokens=10),
            )
        return ModelResponse(
            parts=[TextPart("done")], usage=RequestUsage(input_tokens=20)
        )

    runner = PydanticModelRunner(
        Settings(), build_model=lambda config: FunctionModel(respond)
    )

    @runner._agent.tool_plain
    def image() -> ToolReturn:
        return ToolReturn(
            return_value="image result",
            content=[BinaryContent(data=b"image", media_type="image/png")],
        )

    @runner._agent.tool_plain
    def text() -> str:
        return "text result"

    outcome = runner.run(make_request(observer, recorder), None)
    assert outcome.error is None
    pending = next(
        turn
        for turn in reversed(seen)
        if turn.requests
        and len(turn.requests[0].tools) == 2
        and all(tool.result_json is not None for tool in turn.requests[0].tools)
    )
    raw = ModelMessagesTypeAdapter.validate_json(outcome.messages_json)
    first_response = next(
        message for message in raw if isinstance(message, ModelResponse)
    )
    related = next(
        message
        for message in raw
        if message.metadata and "tool_observations" in message.metadata.get("fora", {})
    )
    assert len(related.parts) == 3
    complete = runner.live_coverage(outcome.messages_json, pending)
    tool_coverage = next(item for item in complete if item.tools)
    assert [index for index, version in tool_coverage.tools] == [0, 1]
    related.parts[0].content = "changed image result"
    changed = ModelMessagesTypeAdapter.dump_json(raw).decode()
    partial = runner.live_coverage(changed, pending)
    tool_coverage = next(item for item in partial if item.tools)
    assert [index for index, version in tool_coverage.tools] == [1]
    handle = ModelRequestHandle(
        pending.requests[0].ordinal, pending.requests[0].request_id
    )
    observer.response(
        handle,
        pending.requests[0].usage_json,
        pending.requests[0].tools,
        None,
        pending.requests[0].response_version,
    )
    observer.saved(partial)
    snapshots.finish(2, 1, "history incomplete")
    retained = snapshots.capture()[0]
    assert retained.status == "unsaved"
    assert not retained.requests[0].tools[0].saved
    assert retained.requests[0].tools[0].result_json is not None
    assert retained.requests[0].tools[1].saved
    assert retained.requests[0].tools[1].result_json is None
    assert json.loads(retained.requests[0].usage_json)["input_tokens"] == 10
    assert json.loads(retained.requests[1].usage_json)["input_tokens"] == 20
    first_response.metadata["fora"]["request_id"] = "another-request"
    wrong_identity = runner.live_coverage(
        ModelMessagesTypeAdapter.dump_json(raw).decode(), pending
    )
    assert not any(
        item.response_version and item.handle == handle for item in wrong_identity
    )
    observer.saved((LiveRequestCoverage(handle, tools=((0, "another-version"),)),))
    assert not snapshots.capture()[0].requests[0].tools[0].saved
    observer.saved(complete)
    snapshots.finish(2, 1, None)
    assert snapshots.capture() == ()
    assert retained.requests[0].tools[0].result_json is not None


def test_sdk_cancellation_only_terminates_unfinished_tools():
    release = threading.Event()

    def emit(name, payload):
        turn = snapshots.capture()[0]
        if turn.requests and any(
            tool.tool_name == "short" and tool.status == "completed"
            for tool in turn.requests[0].tools
        ):
            release.set()

    snapshots = LiveSnapshots(emit)
    observer = snapshots.begin(run_record())
    recorder = Recorder(snapshots)
    runner = PydanticModelRunner(
        Settings(),
        build_model=lambda config: FunctionModel(
            lambda messages, info: ModelResponse(
                parts=[
                    ToolCallPart("short", {}, tool_call_id="short"),
                    ToolCallPart("cancelled", {}, tool_call_id="cancelled"),
                ]
            )
        ),
    )

    @runner._agent.tool_plain
    async def short() -> str:
        return "completed result"

    @runner._agent.tool_plain
    async def cancelled() -> str:
        assert await asyncio.to_thread(release.wait, 2)
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        runner.run(make_request(observer, recorder), None)
    tools = snapshots.capture()[0].requests[0].tools
    assert [tool.status for tool in tools] == ["completed", "cancelled"]
    assert tools[0].result_json is not None
    assert tools[1].completed_at is not None
