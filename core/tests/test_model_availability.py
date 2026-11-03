from typing import Any

import pytest

from fora.adapters.model.config import ModelCatalog
from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError


def stored_settings(provider_enabled: bool) -> dict[str, Any]:
    return {
        "version": 2,
        "providers": [
            {
                "id": "deepseek",
                "name": "DeepSeek",
                "api_type": "openai-chat",
                "base_url": "https://api.deepseek.com",
                "api_key": "sk-test-deepseek",
                "enabled": provider_enabled,
            }
        ],
        "models": [
            {
                "id": "chat",
                "provider_id": "deepseek",
                "name": "Chat",
                "model": "deepseek-chat",
                "thinking_budget_tokens": None,
            }
        ],
        "default_model_id": None,
        "default_thinking": "default",
    }


def test_disabling_a_provider_keeps_its_models_listed() -> None:
    catalog = ModelCatalog.restore(stored_settings(True)).apply(
        {"action": "save_provider", "id": "deepseek", "values": {"enabled": False}},
        set(),
    )
    public = catalog.public()
    assert public["providers"][0]["enabled"] is False
    assert [model["name"] for model in public["models"]] == ["Chat"]


def test_choosing_a_model_under_a_disabled_provider_names_the_provider() -> None:
    catalog = ModelCatalog.restore(stored_settings(False))
    with pytest.raises(DomainError) as error:
        catalog.apply(
            {"action": "set_agent", "id": 3, "values": {"model_id": "chat"}},
            {3},
        )
    assert error.value.code == ErrorCode.MODEL_IN_USE
    assert str(error.value) == "Agent 3 references a disabled provider"


def test_disabling_a_provider_a_member_uses_names_the_provider() -> None:
    settings = stored_settings(True)
    settings["agent_configs"] = {"3": {"model_id": "chat", "thinking": None}}
    catalog = ModelCatalog.restore(settings)
    with pytest.raises(DomainError) as error:
        catalog.apply(
            {"action": "save_provider", "id": "deepseek", "values": {"enabled": False}},
            {3},
        )
    assert error.value.code == ErrorCode.MODEL_IN_USE
    assert str(error.value) == "Agent 3 references a disabled provider"
