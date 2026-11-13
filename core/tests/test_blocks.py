import json

import pytest
from pydantic_ai.messages import (
    BinaryContent,
    FilePart,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    RetryFeedbackPart,
    RetryInfo,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.usage import RequestUsage

from fora.adapters.model.blocks import PartKinds, from_blocks, render_block, to_blocks
from fora.core.blocks import Block, WindowContent
from fora.runtime.reminder import HistoryPersistenceError, HistoryValidationError

WINDOW = [
    ModelRequest(
        parts=[UserPromptPart("MEMORY")],
        metadata={"fora": {"cache_key": "k"}},
    ),
    ModelResponse(
        parts=[
            ThinkingPart("plan", signature="sig", provider_name="anthropic"),
            TextPart("looking"),
            ToolCallPart("run", {"argv": ["ls"]}, tool_call_id="a"),
            ToolCallPart("view_image", {"path": "/x.png"}, tool_call_id="b"),
        ],
        usage=RequestUsage(input_tokens=10, output_tokens=5),
        model_name="model",
        provider_response_id="response",
        finish_reason="tool_call",
    ),
    ModelRequest(
        parts=[
            ToolReturnPart(
                "view_image",
                [{"path": "/x.png"}, BinaryContent(b"\x89PNG", media_type="image/png")],
                tool_call_id="b",
            ),
            ToolReturnPart("run", "bad argv", tool_call_id="a", outcome="retried"),
            UserPromptPart("The execution environment changed."),
        ]
    ),
    ModelResponse(parts=[ToolCallPart("run", {"argv": ["pwd"]}, tool_call_id="a")]),
    ModelRequest(parts=[ToolReturnPart("run", "/", tool_call_id="a")]),
    ModelResponse(parts=[TextPart("done")]),
    ModelRequest(
        parts=[RetryFeedbackPart("answer in text", retry=RetryInfo("no_output"))]
    ),
    ModelResponse(parts=[]),
]
KINDS = PartKinds()
KINDS.mark(WINDOW[0].parts[0], "context")
KINDS.mark(WINDOW[2].parts[2], "environment")


STRUCTURED = """run {"argv":["ls"]}
Result:
exit_code: 0
stdout:
  a
  b
stderr:
files:
  - path: /x
    tags:
      - p
  - y"""


def encoded(messages) -> bytes:
    return ModelMessagesTypeAdapter.dump_json(messages)


def parts(block: Block) -> list[tuple[int, int, str]]:
    return [
        (position, index, part["part_kind"])
        for position, index, part in json.loads(block.parts)
    ]


def test_a_window_reads_back_exactly_as_it_was_written() -> None:
    assert encoded(from_blocks(to_blocks(WINDOW, KINDS))) == encoded(WINDOW)


def test_each_tool_call_shares_a_block_with_its_result() -> None:
    content = to_blocks(WINDOW, KINDS)

    assert [block.kind for block in content.blocks] == [
        "context",
        "thinking",
        "text",
        "tool",
        "tool",
        "environment",
        "tool",
        "text",
        "retry",
    ]
    assert parts(content.blocks[3]) == [(1, 2, "tool-call"), (2, 1, "tool-return")]
    assert parts(content.blocks[4]) == [(1, 3, "tool-call"), (2, 0, "tool-return")]
    assert parts(content.blocks[6]) == [(3, 0, "tool-call"), (4, 0, "tool-return")]
    assert len(content.message_heads) == len(WINDOW)


def test_a_call_without_a_result_stays_an_open_block() -> None:
    messages = WINDOW[:2]
    content = to_blocks(messages, KINDS)

    assert parts(content.blocks[-1]) == [(1, 3, "tool-call")]
    assert encoded(from_blocks(content)) == encoded(messages)


def test_repeated_call_ids_pair_in_order() -> None:
    messages = [
        ModelResponse(
            parts=[
                ToolCallPart("run", {}, tool_call_id="same"),
                ToolCallPart("run", {}, tool_call_id="same"),
            ]
        ),
        ModelRequest(
            parts=[
                ToolReturnPart("run", "first", tool_call_id="same"),
                ToolReturnPart("run", "second", tool_call_id="same"),
            ]
        ),
    ]
    content = to_blocks(messages, KINDS)

    assert [parts(block) for block in content.blocks] == [
        [(0, 0, "tool-call"), (1, 0, "tool-return")],
        [(0, 1, "tool-call"), (1, 1, "tool-return")],
    ]
    assert encoded(from_blocks(content)) == encoded(messages)


def test_a_result_without_its_call_is_refused() -> None:
    with pytest.raises(HistoryPersistenceError):
        to_blocks(
            [ModelRequest(parts=[ToolReturnPart("run", "/", tool_call_id="x")])],
            PartKinds(),
        )


def test_a_part_with_no_block_kind_is_refused() -> None:
    with pytest.raises(HistoryPersistenceError):
        to_blocks(
            [
                ModelResponse(
                    parts=[FilePart(BinaryContent(b"x", media_type="image/png"))]
                )
            ],
            PartKinds(),
        )


def test_a_message_missing_a_part_is_invalid() -> None:
    content = to_blocks(WINDOW, KINDS)
    damaged = WindowContent(content.message_heads, content.blocks[:-2])

    with pytest.raises(HistoryValidationError):
        from_blocks(damaged)


def test_a_structured_result_reads_line_by_line() -> None:
    content = to_blocks(
        [
            ModelResponse(
                parts=[ToolCallPart("run", {"argv": ["ls"]}, tool_call_id="r")]
            ),
            ModelRequest(
                parts=[
                    ToolReturnPart(
                        "run",
                        {
                            "exit_code": 0,
                            "stdout": "a\nb\n",
                            "stderr": "",
                            "files": [{"path": "/x", "tags": ["p"]}, "y"],
                        },
                        tool_call_id="r",
                    )
                ]
            ),
        ],
        PartKinds(),
    )

    assert render_block(content.blocks[0]) == STRUCTURED


def test_a_retried_call_reads_as_an_error() -> None:
    assert (
        render_block(to_blocks(WINDOW, KINDS).blocks[3])
        == 'run {"argv":["ls"]}\nError:\nbad argv'
    )


def test_a_prompt_without_a_kind_is_refused() -> None:
    with pytest.raises(HistoryPersistenceError):
        to_blocks([ModelRequest(parts=[UserPromptPart("who am I")])], PartKinds())


def test_reading_a_window_back_keeps_each_block_kind() -> None:
    content = to_blocks(WINDOW, KINDS)
    kinds = PartKinds()

    assert to_blocks(from_blocks(content, kinds), kinds) == content


def test_ephemeral_parts_are_never_stored() -> None:
    kinds = PartKinds()
    kept = UserPromptPart("woken")
    nudge = UserPromptPart("reply soon")
    kinds.mark(kept, "reminder")
    kinds.mark_ephemeral(nudge)

    content = to_blocks(kinds.persistent([ModelRequest(parts=[kept, nudge])]), kinds)

    assert [block.kind for block in content.blocks] == ["reminder"]
    assert "reply soon" not in content.blocks[0].parts
