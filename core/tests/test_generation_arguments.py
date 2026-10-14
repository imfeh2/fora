from __future__ import annotations

import json
from decimal import Decimal
from importlib.metadata import distribution
from pathlib import Path

import pytest

import ijson
from fora.adapters.model.generation import evaluate_preview
from fora.ports.agent import SendPreviewCandidate


@pytest.mark.parametrize(
    "args,expected",
    [
        ('{"action":"send","discussion_id":6', None),
        ('{"action":"send","discussion_id":62', None),
        ('{"action":"send","discussion_id":62,', None),
        ('{"action":"send","discussion_id":62,"body":"Hello', (62, "Hello")),
        ('{"body":"Hello","action":"send","discussion_id":6', None),
        ('{"body":"Hello","action":"send","discussion_id":62}', (62, "Hello")),
        ('{"body":"Hello","discussion_id":62,"action":"sen', None),
        ('{"body":"Hello","discussion_id":62,"action":"send"', (62, "Hello")),
        ('{"action":"send","discussion_id":62,"body":""}', (62, "")),
        ('{"body":"中文😀","discussion_id":62,"action":"send"}', (62, "中文😀")),
        (
            '{"body":"a\\nb\\"c\\\\d","action":"send","discussion_id":62}',
            (62, 'a\nb"c\\d'),
        ),
        ('{"action":"send","discussion_id":62,"body":"\\u4e2d\\u6587', (62, "中文")),
        ('{"action":"send","discussion_id":62,"body":"text\\u4e', (62, "text")),
        ('{"action":"send","discussion_id":true,"body":"Hello"}', None),
        ('{"action":"send","discussion_id":0,"body":"Hello"}', None),
        ('{"action":"send","discussion_id":-1,"body":"Hello"}', None),
        ('{"action":"send","discussion_id":6.2,"body":"Hello"}', None),
        ('{"action":"send","discussion_id":6e2,"body":"Hello"}', None),
        ('{"action":"send","discussion_id":9223372036854775808,"body":"Hello"}', None),
        ('{"action":"read","discussion_id":62,"body":"Hello"}', None),
        ('{"action":"send","discussion_id":62,"body":{}}', None),
        ('{"action":"send","discussion_id":62,"body":null}', None),
        ('["send",62,"Hello"]', None),
        ('{"nested":{"action":"send","discussion_id":62,"body":"Hello"}}', None),
        ('{"action":"send","discussion_id":62}', None),
        ('{"action":"send","body":"Hello"}', None),
    ],
)
def test_string_candidates_require_complete_identity_and_current_body(args, expected):
    result = evaluate_preview("discussion", args)
    assert result.error is None
    assert result.candidate == (SendPreviewCandidate(*expected) if expected else None)


@pytest.mark.parametrize(
    "args",
    [
        '{"action":"send","discussion_id":62,"body":"Hello","action":',
        '{"action":"send","discussion_id":62,"body":"Hello","body":"Other"}',
        '{"action":"send","discussion_id":62,"body":"Hello","discussion_id":63}',
        '{"action":"send","discussion_id":62,"body":"Hello","nested":{"x":1,"x":2}}',
        '{"action":"send","discussion_id":06,"body":"Hello"}',
        '{"action":"send","discussion_id":62,"body":"\\q"}',
        '{"action":"send","discussion_id":62,"body":"Hello"} trailing',
        '{"action":"send","discussion_id":62,"body":"Hello", invalid}',
    ],
)
def test_invalid_json_and_duplicate_keys_stop_candidates(args):
    result = evaluate_preview("discussion", args)
    assert result.candidate is None
    assert result.error is not None
    assert "Hello" not in result.error


@pytest.mark.parametrize("target", [True, False, 0, -1, 6.2, "62", None])
def test_dictionary_candidate_rejects_invalid_target_types(target):
    assert (
        evaluate_preview(
            "discussion", {"action": "send", "discussion_id": target, "body": "Hello"}
        ).candidate
        is None
    )


def test_dictionary_snapshots_and_tool_name_replacements_use_current_identity():
    args = {"action": "send", "discussion_id": 62, "body": "First"}
    assert evaluate_preview("discussion", args).candidate == SendPreviewCandidate(
        62, "First"
    )
    assert evaluate_preview("other", args).candidate is None
    args["discussion_id"] = 63
    args["body"] = "Second"
    assert evaluate_preview("discussion", args).candidate == SendPreviewCandidate(
        63, "Second"
    )
    args["action"] = "read"
    assert evaluate_preview("discussion", args).candidate is None


def test_ijson_declared_interfaces_match_installed_events_and_exceptions():
    events = ijson.sendable_list()
    parser = ijson.parse_coro(events)
    parser.send(
        b'{"decimal":1.5,"integer":62,"boolean":true,"nothing":null,"text":"hello"}'
    )
    parser.close()
    scalars = {
        prefix: value
        for prefix, event, value in events
        if event in ("number", "boolean", "null", "string")
    }
    assert scalars == {
        "decimal": Decimal("1.5"),
        "integer": 62,
        "boolean": True,
        "nothing": None,
        "text": "hello",
    }
    parser = ijson.parse_coro(ijson.sendable_list())
    parser.send(b'{"incomplete":')
    with pytest.raises(ijson.IncompleteJSONError):
        parser.close()
    assert issubclass(ijson.IncompleteJSONError, ijson.JSONError)
    assert (
        Path(ijson.__file__).resolve().parent
        == Path(distribution("ijson").locate_file("ijson")).resolve()
    )


@pytest.mark.parametrize("args", [None, "", " ", "\n", "{", '{"', {}])
def test_initial_argument_fragments_wait_for_identity(args):
    result = evaluate_preview("discussion", args)
    assert result.candidate is None and result.error is None


def test_each_fragment_prefix_uses_library_scalar_end_events():
    source = json.dumps(
        {"body": "中文😀", "action": "send", "discussion_id": 62}, ensure_ascii=False
    )
    for index in range(1, len(source)):
        assert evaluate_preview("discussion", source[:index]).candidate is None
    assert evaluate_preview("discussion", source).candidate == SendPreviewCandidate(
        62, "中文😀"
    )
