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


def test_public_view_returns_the_stored_key() -> None:
    provider = catalog().public()["providers"][0]
    assert provider["api_key"] == "sk-test-deepseek"
    assert provider["api_key_set"] is True


def test_saving_an_empty_key_clears_it() -> None:
    updated = catalog().apply(
        {
            "action": "save_provider",
            "id": "deepseek",
            "values": {
                "name": "DeepSeek",
                "api_type": "openai-chat",
                "base_url": "https://api.deepseek.com",
                "api_key": "",
            },
        },
        set(),
    )
    assert updated.provider("deepseek").api_key == ""
    assert updated.public()["providers"][0]["api_key_set"] is False


def test_saving_a_new_key_replaces_it() -> None:
    updated = catalog().apply(
        {
            "action": "save_provider",
            "id": "deepseek",
            "values": {
                "name": "DeepSeek",
                "api_type": "openai-chat",
                "base_url": "https://api.deepseek.com",
                "api_key": "sk-test-new",
            },
        },
        set(),
    )
    assert updated.provider("deepseek").api_key == "sk-test-new"
