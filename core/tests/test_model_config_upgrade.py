from typing import Any

from fora.adapters.model.config import ModelCatalog


def stored_settings(switch: bool) -> dict[str, Any]:
    return {
        "version": 2,
        "providers": [
            {
                "id": "deepseek",
                "name": "DeepSeek",
                "api_type": "openai-chat",
                "base_url": "https://api.deepseek.com",
                "api_key": "sk-test-deepseek",
                "enabled": True,
            }
        ],
        "models": [
            {
                "id": "chat",
                "provider_id": "deepseek",
                "name": "Chat",
                "model": "deepseek-chat",
                "thinking_budget_tokens": None,
                "enabled": switch,
            }
        ],
        "default_model_id": "chat",
        "default_thinking": "default",
    }


def test_stored_settings_with_the_old_model_switch_still_load() -> None:
    public = ModelCatalog.restore(stored_settings(True)).public()
    assert [provider["name"] for provider in public["providers"]] == ["DeepSeek"]
    assert [model["name"] for model in public["models"]] == ["Chat"]
    assert "enabled" not in public["models"][0]


def test_a_model_switched_off_in_old_settings_is_still_selectable() -> None:
    catalog = ModelCatalog.restore(stored_settings(False))
    assert catalog.resolve().registered_model_id == "chat"
