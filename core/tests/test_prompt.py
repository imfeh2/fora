from fora.adapters.model.prompt import SYSTEM_PROMPT


def test_prompt_separates_rules_from_work_state() -> None:
    assert "AGENTS.md and MEMORY.md do different jobs." in SYSTEM_PROMPT
    assert "Keep them apart." in SYSTEM_PROMPT
    assert (
        "A workspace AGENTS.md is read together with the organization's shared one."
        in SYSTEM_PROMPT
    )


def test_prompt_keeps_the_memory_maintenance_paragraph() -> None:
    assert (
        "MEMORY.md is placed in your context at the start of each context window"
        in SYSTEM_PROMPT
    )
