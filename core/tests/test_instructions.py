from __future__ import annotations

from fora.runtime.instructions import Instructions, Skill, changes, sections, state

RULES = """Opening line.

# Language

Write in Chinese.

## Words

Use plain words.

# Code

No comments.

```
# not a heading
```
"""


def instructions(library: str, *skills: Skill, workspace: str = "") -> Instructions:
    return Instructions(
        files=(("library", library), ("workspace", workspace)), skills=skills
    )


def test_sections_follow_the_headings() -> None:
    assert [key for key, _ in sections(RULES)] == [
        "",
        "Language",
        "Language > Words",
        "Code",
    ]
    assert sections(RULES)[3][1].endswith("# not a heading\n```")


def test_nothing_changed_adds_nothing() -> None:
    current = instructions(RULES, Skill("flow", "library", "Runs a task."))
    assert changes(state(current), current) is None


def test_only_the_changed_section_is_sent() -> None:
    before = instructions(RULES)
    after = instructions(RULES.replace("Use plain words.", "Use short words."))

    text = changes(state(before), after)

    assert text is not None
    assert "Section Language > Words:\n## Words\n\nUse short words." in text
    assert "Write in Chinese." not in text
    assert "No comments." not in text


def test_removed_sections_are_named() -> None:
    before = instructions(RULES)
    after = instructions(RULES.split("# Code")[0])

    text = changes(state(before), after)

    assert text is not None
    assert "removed sections: Code" in text


def test_skill_changes_list_only_those_skills() -> None:
    kept = Skill("kept", "library", "Stays.")
    before = instructions(
        "", kept, Skill("old", "library", "Goes."), Skill("edit", "workspace", "One.")
    )
    after = instructions(
        "",
        kept,
        Skill("edit", "workspace", "Two."),
        Skill("new", "library", "Arrives."),
    )

    text = changes(state(before), after)

    assert text is not None
    assert "- edit (workspace): Two." in text
    assert "- new (library): Arrives." in text
    assert "Skills removed:\n- old (library)" in text
    assert "kept" not in text


def test_a_window_without_a_record_receives_everything() -> None:
    text = changes(None, instructions("Rule.", workspace="Own rule."))

    assert text is not None
    assert "Rule." in text and "Own rule." in text
