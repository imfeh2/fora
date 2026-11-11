import pytest

from fora.core.errors import DomainError
from fora.core.permissions import (
    Entry,
    Grant,
    Permissions,
    parse_entries,
    render,
    render_entry,
)

OWNER = 1
LEAD = 2
REVIEWER = 3
HELPER = 4


def grant(
    id: int,
    holder: int,
    by: int,
    parent: int | None,
    *entries: Entry,
    revoked: bool = False,
) -> Grant:
    return Grant(
        id, holder, by, parent, entries, "2026-11-10", "2026-11-11" if revoked else None
    )


def plus(*node: str, delegable: bool = False) -> Entry:
    return Entry("+", node, delegable)


def minus(*node: str) -> Entry:
    return Entry("-", node)


def organization(*grants: Grant) -> Permissions:
    return Permissions(OWNER, grants)


def test_the_owner_holds_everything_including_the_reserved_branch() -> None:
    permissions = organization()

    assert permissions.allows(OWNER, ("files", "write", "project"))
    assert permissions.allows(OWNER, ("owner", "transfer"))
    with pytest.raises(DomainError):
        permissions.parent_for(OWNER, [plus("owner", "transfer")])


def test_a_node_covers_everything_below_it_but_nothing_beside_it() -> None:
    permissions = organization(grant(1, LEAD, OWNER, None, plus("library", "write")))

    assert permissions.allows(LEAD, ("library", "write"))
    assert permissions.allows(LEAD, ("library", "write", "rules", "task-flow.md"))
    assert not permissions.allows(LEAD, ("library", "read"))
    assert not permissions.allows(LEAD, ("library",))


def test_an_excluded_branch_stays_closed_for_everyone_downstream() -> None:
    permissions = organization(
        grant(
            1,
            LEAD,
            OWNER,
            None,
            plus(delegable=True),
            minus("library", "write", "specs"),
        ),
        grant(2, REVIEWER, LEAD, 1, plus("library", "write")),
    )

    assert permissions.allows(LEAD, ("library", "write", "rules"))
    assert not permissions.allows(LEAD, ("library", "write", "specs", "context.md"))
    assert permissions.allows(REVIEWER, ("library", "write", "rules"))
    assert not permissions.allows(REVIEWER, ("library", "write", "specs"))


def test_the_reserved_owner_branch_is_never_reached_through_a_grant() -> None:
    permissions = organization(grant(1, LEAD, OWNER, None, plus(delegable=True)))

    assert permissions.allows(LEAD, ("member", "create"))
    assert not permissions.allows(LEAD, ("owner", "transfer"))
    with pytest.raises(DomainError):
        permissions.parent_for(LEAD, [plus("owner")])


def test_only_the_delegable_part_can_be_granted_on() -> None:
    permissions = organization(
        grant(
            1,
            LEAD,
            OWNER,
            None,
            plus("files", "write", "project", delegable=True),
            plus("member", "create"),
        )
    )

    assert (
        permissions.parent_for(LEAD, [plus("files", "write", "project", "fora")]) == 1
    )
    with pytest.raises(DomainError):
        permissions.parent_for(LEAD, [plus("member", "create")])
    with pytest.raises(DomainError):
        permissions.parent_for(LEAD, [plus("files", "write")])


def test_a_grant_without_delegable_entries_cannot_be_passed_on() -> None:
    permissions = organization(
        grant(1, LEAD, OWNER, None, plus("library", delegable=True)),
        grant(2, REVIEWER, LEAD, 1, plus("library", "read")),
        grant(3, HELPER, REVIEWER, 2, plus("library", "read")),
    )

    assert permissions.allows(REVIEWER, ("library", "read", "notes.md"))
    assert not permissions.allows(HELPER, ("library", "read", "notes.md"))
    with pytest.raises(DomainError):
        permissions.parent_for(REVIEWER, [plus("library", "read")])


def test_revoking_a_grant_closes_everything_granted_from_it() -> None:
    permissions = organization(
        grant(1, LEAD, OWNER, None, plus(delegable=True), revoked=True),
        grant(2, REVIEWER, LEAD, 1, plus("library", "read")),
    )

    assert not permissions.allows(LEAD, ("library", "read"))
    assert not permissions.allows(REVIEWER, ("library", "read"))
    assert permissions.grants_of(REVIEWER) == ()


def test_upstream_granters_can_revoke_and_others_cannot() -> None:
    permissions = organization(
        grant(1, LEAD, OWNER, None, plus(delegable=True)),
        grant(2, REVIEWER, LEAD, 1, plus("library", delegable=True)),
        grant(3, HELPER, REVIEWER, 2, plus("library", "read")),
    )

    assert permissions.can_revoke(OWNER, 3)
    assert permissions.can_revoke(LEAD, 3)
    assert permissions.can_revoke(REVIEWER, 3)
    assert not permissions.can_revoke(HELPER, 3)
    assert not permissions.can_revoke(REVIEWER, 1)


def test_boundaries_list_every_node_where_the_answer_can_change() -> None:
    permissions = organization(
        grant(
            1,
            LEAD,
            OWNER,
            None,
            plus("files", "write", "project", delegable=True),
            minus("files", "write", "project", "fora", "core"),
        ),
        grant(2, REVIEWER, LEAD, 1, plus("files", "write", "project", "fora")),
    )
    action = ("files", "write")

    assert permissions.boundaries(REVIEWER, action) == (
        action,
        ("files", "write", "project"),
        ("files", "write", "project", "fora"),
        ("files", "write", "project", "fora", "core"),
    )
    assert [
        permissions.allows(REVIEWER, node)
        for node in permissions.boundaries(REVIEWER, action)
    ] == [False, False, True, False]


def test_entries_are_checked_before_they_are_stored() -> None:
    entries = parse_entries(
        [
            {"sign": "+", "node": ["library", "write"], "delegable": True},
            {"sign": "-", "node": ["library", "write", "specs"]},
        ]
    )

    assert [render_entry(entry) for entry in entries] == [
        "+ library:write (delegable)",
        "- library:write:specs",
    ]
    for bad in (
        [],
        [{"sign": "-", "node": ["library"]}],
        [{"sign": "+", "node": "library:write"}],
        [{"sign": "+", "node": ["library", ""]}],
        [{"sign": "-", "node": ["library"], "delegable": True}],
        [
            {"sign": "+", "node": ["library", "write", "specs"]},
            {"sign": "-", "node": ["library"]},
        ],
        [{"sign": "+", "node": ["library"], "extra": 1}],
    ):
        with pytest.raises(DomainError):
            parse_entries(bad)


def test_parts_that_contain_the_separator_are_quoted() -> None:
    assert render(()) == "*"
    assert render(("files", "write", "C:", "Users")) == 'files:write:"C:":Users'
    assert render(("library", "read", "task-flow.md")) == "library:read:task-flow.md"
