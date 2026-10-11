from __future__ import annotations

import pytest

from fora.core.errors import DomainError
from fora.core.member import Member, name_key, normalize_name, validate_name
from fora.core.mention import build_mentions, find_mention_ids

HUMAN = Member(1, "human", "You")
MAIN = Member(13, "agent", "Main")
TM = Member(36, "agent", "Technical Manager")
PA = Member(98, "agent", "Product Advisor")
GONE = Member(7, "agent", "Retired", deleted=True)
ALL = (HUMAN, MAIN, TM, PA, GONE)


def ids(body: str) -> tuple[int, ...]:
    return tuple(member_id for member_id, _, _ in find_mention_ids(body, ALL))


def test_normalizes_whitespace_and_case_for_identity() -> None:
    assert normalize_name("  Technical   Manager ") == "Technical Manager"
    assert name_key("TECHNICAL manager") == name_key("Technical Manager")


def test_rejects_empty_at_sign_and_overlong_names() -> None:
    with pytest.raises(DomainError):
        validate_name("   ")
    with pytest.raises(DomainError):
        validate_name("bad@name")
    with pytest.raises(DomainError):
        validate_name("x" * 65)
    assert validate_name(" Main ") == "Main"


def test_matches_multi_word_name_over_shorter_prefix() -> None:
    assert find_mention_ids("@Technical Manager please look", ALL) == ((36, 0, 18),)


def test_does_not_match_when_name_is_a_prefix_of_a_longer_word() -> None:
    assert ids("@Mainframe is down") == ()


def test_ignores_at_sign_preceded_by_word_character() -> None:
    assert ids("mail me at you@Main.example") == ()


def test_deleted_members_are_not_mentionable() -> None:
    assert ids("@Retired are you there") == ()


def test_matches_case_insensitively() -> None:
    assert find_mention_ids("@product advisor", ALL) == ((98, 0, 16),)


def test_multiline_body_reports_positions_in_original_text() -> None:
    body = "first line\n\nsecond @Main here"
    found = find_mention_ids(body, ALL)
    assert found == ((13, 19, 5),)
    assert body[19:24] == "@Main"


def test_repeated_mentions_collapse_to_one_per_member() -> None:
    mentions = build_mentions(3, 42, "@Main and again @Main", ALL)
    assert [item.member_id for item in mentions] == [13]
    assert mentions[0].discussion_id == 3
    assert mentions[0].message_id == 42
    assert (mentions[0].position, mentions[0].length) == (0, 5)


def test_several_distinct_members_in_one_body() -> None:
    assert ids("@Main @Technical Manager @Product Advisor") == (13, 36, 98)


@pytest.mark.parametrize("body", ["@all", "@ALL", "@AlL!", "@all_", "_@all"])
def test_all_expands_to_active_members(body: str) -> None:
    mentions = build_mentions(3, 42, body, iter(ALL), sender_id=1)
    assert [item.member_id for item in mentions] == [13, 36, 98]
    assert all(item.length == 4 for item in mentions)


@pytest.mark.parametrize(
    "body", ["mail@all", "中@all", "@all中文", "@all2", "@allison"]
)
def test_all_respects_existing_word_boundaries(body: str) -> None:
    assert find_mention_ids(body, ALL) == ()


def test_all_keeps_first_valid_position_per_recipient() -> None:
    body = "😀 @Main @ALL @Product Advisor @all"
    mentions = build_mentions(3, 42, body, ALL, sender_id=1)
    assert [(item.member_id, item.position, item.length) for item in mentions] == [
        (13, 2, 5),
        (36, 8, 4),
        (98, 8, 4),
    ]
    mentions = build_mentions(3, 42, "@all @Main @all", ALL, sender_id=13)
    assert [(item.member_id, item.position, item.length) for item in mentions] == [
        (1, 0, 4),
        (36, 0, 4),
        (98, 0, 4),
    ]


def test_all_has_no_recipients_when_only_sender_is_active() -> None:
    assert build_mentions(1, 1, "@all", (MAIN, GONE), sender_id=13) == ()
    assert build_mentions(1, 1, "@all", ()) == ()


def test_all_preserves_paused_member_identity_and_all_names() -> None:
    people = (
        HUMAN,
        Member(2, "agent", "ALL", state="paused"),
        Member(3, "agent", "All Hands"),
        Member(4, "agent", "Allison"),
        GONE,
    )
    assert find_mention_ids("@All Hands @allison", people) == (
        (3, 0, 10),
        (4, 11, 8),
    )
    mentions = build_mentions(1, 1, "@all", people, sender_id=1)
    assert [item.member_id for item in mentions] == [2, 3, 4]
    assert build_mentions(1, 1, "@All Hands", (HUMAN,), sender_id=1) == ()


def test_repeated_all_expands_members_only_once() -> None:
    people = tuple(Member(index, "agent", f"Member {index}") for index in range(100))
    found = find_mention_ids("@all " * 1000, reversed(people))
    assert len(found) == 100
    assert found == tuple((index, 0, 4) for index in range(100))


def test_mentioning_yourself_creates_no_pending_item() -> None:
    mentions = build_mentions(
        1, 1, "@Main note to self and @Product Advisor", ALL, sender_id=13
    )
    assert [item.member_id for item in mentions] == [98]
