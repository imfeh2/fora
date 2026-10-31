from typing import Any

from fora.adapters.model.config import ModelCatalog


def catalog() -> ModelCatalog:
    return ModelCatalog.restore(
        {
            "version": 2,
            "providers": [
                {
                    "id": "deepseek",
                    "name": "DeepSeek",
                    "api_type": "openai-chat",
                    "base_url": "https://api.deepseek.com",
                    "api_key": "sk-test-deepseek",
                }
            ],
        }
    )


def save(values: dict[str, Any]) -> ModelCatalog:
    return catalog().apply(
        {"action": "save_provider", "id": "deepseek", "values": values},
        set(),
    )


def test_public_view_returns_the_stored_key() -> None:
    provider = catalog().public()["providers"][0]
    assert provider["api_key"] == "sk-test-deepseek"
    assert provider["api_key_set"] is True


def test_saving_an_empty_key_clears_it() -> None:
    updated = save({"api_key": ""})
    assert updated.provider("deepseek").api_key == ""
    assert updated.public()["providers"][0]["api_key_set"] is False


def test_saving_a_new_key_replaces_it() -> None:
    updated = save({"api_key": "sk-test-new"})
    assert updated.provider("deepseek").api_key == "sk-test-new"


def test_legacy_save_without_a_key_keeps_the_stored_key() -> None:
    updated = save({"name": "Renamed", "api_key": "", "clear_key": False})
    assert updated.provider("deepseek").name == "Renamed"
    assert updated.provider("deepseek").api_key == "sk-test-deepseek"
    assert updated.public()["providers"][0]["api_key_set"] is True


def test_legacy_save_with_a_new_key_replaces_it() -> None:
    updated = save({"api_key": "sk-test-new", "clear_key": False})
    assert updated.provider("deepseek").api_key == "sk-test-new"


def test_legacy_save_with_clear_key_clears_the_stored_key() -> None:
    updated = save({"api_key": "", "clear_key": True})
    assert updated.provider("deepseek").api_key == ""
    assert updated.public()["providers"][0]["api_key_set"] is False
