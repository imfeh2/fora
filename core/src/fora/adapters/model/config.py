from __future__ import annotations

import json
import math
import re
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Literal, cast, get_args
from uuid import uuid4

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    ValidationError,
    model_validator,
)

from fora.core.error_codes import ErrorCode
from fora.core.errors import DomainError

ApiType = Literal["openai-chat", "openai-responses", "anthropic", "google"]

API_TYPES: tuple[ApiType, ...] = get_args(ApiType)
Thinking = Literal[
    "default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "budget"
]
THINKING_OPTIONS: tuple[Thinking, ...] = (
    "default",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
)
BUDGET_API_TYPES = ("anthropic", "google")


def thinking_options(
    api_type: ApiType, model: str, thinking_budget_tokens: int | None = None
) -> list[Thinking]:
    options = list(THINKING_OPTIONS)
    if api_type in BUDGET_API_TYPES and thinking_budget_tokens is not None:
        options.append("budget")
    return options


def validate_thinking(value: Any, model: str) -> Thinking:
    if type(value) is not str or value not in (*THINKING_OPTIONS, "budget"):
        raise DomainError(
            ErrorCode.UNSUPPORTED_THINKING, f"Invalid thinking option for model {model}"
        )
    return cast(Thinking, value)


def validate_thinking_budget(value: Any) -> int:
    if type(value) is not int or value <= 0:
        raise DomainError(
            ErrorCode.INVALID_THINKING_BUDGET,
            "Thinking token budget must be a positive integer",
        )
    return value


def thinking_settings(
    api_type: ApiType,
    model: str,
    thinking: Thinking,
    thinking_budget_tokens: int | None = None,
) -> dict[str, Any]:
    thinking = validate_thinking(thinking, model)
    if thinking == "default":
        return {}
    if thinking == "budget":
        if api_type not in BUDGET_API_TYPES:
            raise DomainError(
                ErrorCode.UNSUPPORTED_THINKING,
                f"Model {model} does not support token budgets",
            )
        tokens = validate_thinking_budget(thinking_budget_tokens)
        if api_type == "anthropic":
            return {
                "anthropic_thinking": {"type": "enabled", "budget_tokens": tokens},
                "max_tokens": tokens + 8192,
            }
        return {
            "google_thinking_config": {"thinking_budget": tokens},
            "max_tokens": tokens + 8192,
        }
    if api_type in ("openai-chat", "openai-responses"):
        return {"openai_reasoning_effort": thinking}
    if api_type == "anthropic":
        if thinking == "none":
            return {"anthropic_thinking": {"type": "disabled"}}
        return {
            "anthropic_thinking": {"type": "adaptive"},
            "anthropic_effort": thinking,
        }
    if thinking == "none":
        return {
            "google_thinking_config": {"thinking_budget": 0},
            "max_tokens": 8192,
        }
    return {"google_thinking_config": {"thinking_level": thinking.upper()}}


REQUEST_BODY_MAX_BYTES = 16 * 1024
REQUEST_BODY_MAX_DEPTH = 16
REQUEST_BODY_CLIENT_FIELDS = frozenset(
    {
        "apikey",
        "authorization",
        "accesstoken",
        "refreshtoken",
        "bearertoken",
        "credentials",
        "credential",
        "password",
        "secretkey",
        "headers",
        "extraheaders",
        "extraquery",
        "baseurl",
        "httpoptions",
        "httpclient",
        "timeout",
        "maxretries",
        "proto",
        "prototype",
        "constructor",
    }
)
REQUEST_BODY_PROTOCOL_FIELDS = frozenset(
    {
        "model",
        "modelname",
        "messages",
        "input",
        "prompt",
        "instructions",
        "system",
        "contents",
        "systeminstruction",
        "tools",
        "toolchoice",
        "functions",
        "functioncall",
        "paralleltoolcalls",
        "stream",
        "streamoptions",
        "responseformat",
        "outputformat",
        "text",
        "modalities",
        "audio",
        "n",
        "conversation",
        "previousresponseid",
        "store",
        "background",
        "include",
        "truncation",
        "contextmanagement",
        "mcpservers",
        "container",
        "cachecontrol",
        "cachedcontent",
        "promptcachekey",
        "promptcacheretention",
        "promptcacheoptions",
        "extrabody",
    }
)


def _request_body_error(path: str, reason: str) -> None:
    raise DomainError(
        ErrorCode.INVALID_REQUEST_BODY, f"Custom request body {path[:160]}: {reason}"
    )


def validate_request_body(value: Any, api_type: ApiType) -> dict[str, JsonValue]:
    if type(value) is not dict:
        _request_body_error("$", "Enter a JSON object.")
    pending = [(value, 1, "$")]
    while pending:
        current, depth, path = pending.pop()
        if isinstance(current, dict | list):
            if depth > REQUEST_BODY_MAX_DEPTH:
                _request_body_error(path, "Use at most 16 container levels.")
            if isinstance(current, dict):
                for key, item in current.items():
                    if type(key) is not str:
                        _request_body_error(path, "Field names must be strings.")
                    if any(0xD800 <= ord(char) <= 0xDFFF for char in key):
                        _request_body_error(path, "Use valid Unicode field names.")
                    child = f"{path}.{key[:64]}"[:160]
                    normalized = re.sub(r"[_\-\s]", "", key).lower()
                    if normalized in REQUEST_BODY_CLIENT_FIELDS:
                        _request_body_error(
                            child, "Remove this protected client field."
                        )
                    if depth == 1:
                        if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", key) is None:
                            _request_body_error(
                                child,
                                "Use a letter followed by up to 63 letters, numbers or underscores.",
                            )
                        if normalized in REQUEST_BODY_PROTOCOL_FIELDS:
                            _request_body_error(
                                child, "Remove this protected protocol field."
                            )
                    pending.append((item, depth + 1, child))
            else:
                pending.extend(
                    (item, depth + 1, f"{path}[{index}]"[:160])
                    for index, item in enumerate(current)
                )
        elif type(current) is str:
            if any(0xD800 <= ord(char) <= 0xDFFF for char in current):
                _request_body_error(path, "Use valid Unicode text.")
        elif type(current) is float:
            if not math.isfinite(current):
                _request_body_error(path, "Numbers must be finite.")
        elif current is not None and type(current) not in (bool, int):
            _request_body_error(path, "Use JSON values only.")
    size = len(
        json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
    )
    if size > REQUEST_BODY_MAX_BYTES:
        _request_body_error("$", "Use at most 16 KiB of UTF-8 JSON.")
    if api_type == "google" and value:
        raise DomainError(
            ErrorCode.UNSUPPORTED_REQUEST_BODY,
            "This API does not support a custom request body. Clear it before saving.",
        )
    incompatible = {
        "openai-chat": {"max_output_tokens"},
        "openai-responses": {"reasoning_effort", "max_completion_tokens", "max_tokens"},
        "anthropic": {
            "reasoning_effort",
            "reasoning",
            "max_completion_tokens",
            "max_output_tokens",
        },
        "google": set(),
    }
    for key in value:
        if key in incompatible[api_type]:
            _request_body_error(f"$.{key}", "Remove this field for the selected API.")
    for key in ("max_tokens", "max_completion_tokens", "max_output_tokens"):
        if key in value and (type(value[key]) is not int or value[key] <= 0):
            _request_body_error(f"$.{key}", "Enter a positive whole number.")
    if "max_tokens" in value and "max_completion_tokens" in value:
        _request_body_error("$", "Use one token limit field.")
    if (
        api_type == "openai-chat"
        and "reasoning_effort" in value
        and type(value["reasoning_effort"]) is not str
    ):
        _request_body_error("$.reasoning_effort", "Enter a string.")
    if api_type == "openai-responses" and "reasoning" in value:
        if type(value["reasoning"]) is not dict:
            _request_body_error("$.reasoning", "Enter an object.")
        if (
            "effort" in value["reasoning"]
            and type(value["reasoning"]["effort"]) is not str
        ):
            _request_body_error("$.reasoning.effort", "Enter a string.")
    if api_type == "anthropic":
        if "thinking" in value:
            thinking = value["thinking"]
            if type(thinking) is not dict or thinking.get("type") not in (
                "enabled",
                "adaptive",
                "disabled",
            ):
                _request_body_error(
                    "$.thinking",
                    "Enter an object with type enabled, adaptive or disabled.",
                )
            if thinking["type"] == "enabled" and (
                type(thinking.get("budget_tokens")) is not int
                or thinking["budget_tokens"] <= 0
            ):
                _request_body_error(
                    "$.thinking.budget_tokens", "Enter a positive whole number."
                )
        if "output_config" in value:
            output = value["output_config"]
            if type(output) is not dict:
                _request_body_error("$.output_config", "Enter an object.")
            if any(re.sub(r"[_\-\s]", "", key).lower() == "format" for key in output):
                _request_body_error(
                    "$.output_config.format", "Remove this protected output field."
                )
            if "effort" in output and type(output["effort"]) is not str:
                _request_body_error("$.output_config.effort", "Enter a string.")
    return deepcopy(cast(dict[str, JsonValue], value))


class ConfigurationRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)


class ProviderConfig(ConfigurationRecord):
    id: str = Field(default_factory=lambda: str(uuid4()), min_length=1)
    name: str = Field(min_length=1)
    api_type: ApiType
    base_url: str = ""
    api_key: str = Field(default="", repr=False)
    enabled: bool = True
    extra_body: dict[str, JsonValue] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def validate_body(cls, values: Any) -> Any:
        if isinstance(values, dict) and values.get("api_type") in API_TYPES:
            validate_request_body(values.get("extra_body", {}), values["api_type"])
        return values


class RegisteredModel(ConfigurationRecord):
    id: str = Field(default_factory=lambda: str(uuid4()), min_length=1)
    provider_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    model: str = Field(min_length=1)
    enabled: bool = True
    thinking_budget_tokens: int | None = Field(default=None, gt=0, strict=True)


LegacyThinking = Literal[
    "default", "none", "minimal", "low", "medium", "high", "xhigh", "max"
]


class LegacyRegisteredModel(ConfigurationRecord):
    id: str = Field(default_factory=lambda: str(uuid4()), min_length=1)
    provider_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    model: str = Field(min_length=1)
    enabled: bool = True


class LegacyAgentModelConfig(ConfigurationRecord):
    model_id: str | None = None
    thinking: LegacyThinking | None = None


class LegacyModelCatalog(ConfigurationRecord):
    version: Literal[1] = 1
    providers: list[ProviderConfig] = Field(default_factory=list)
    models: list[LegacyRegisteredModel] = Field(default_factory=list)
    default_model_id: str | None = None
    default_thinking: LegacyThinking = "default"
    agent_configs: dict[str, LegacyAgentModelConfig] = Field(default_factory=dict)


class AgentModelConfig(ConfigurationRecord):
    model_id: str | None = None
    thinking: Thinking | None = None


class ModelCatalog(ConfigurationRecord):
    version: Literal[2] = 2
    providers: list[ProviderConfig] = Field(default_factory=list)
    models: list[RegisteredModel] = Field(default_factory=list)
    default_model_id: str | None = None
    default_thinking: Thinking = "default"
    agent_configs: dict[str, AgentModelConfig] = Field(default_factory=dict)

    @classmethod
    def restore(cls, values: dict[str, Any] | None) -> ModelCatalog:
        if not values:
            return cls()
        if "version" in values:
            try:
                if values.get("version") == 1:
                    legacy = LegacyModelCatalog.model_validate(values)
                    catalog = cls(
                        providers=legacy.providers,
                        models=[
                            RegisteredModel.model_validate(model.model_dump())
                            for model in legacy.models
                        ],
                        default_model_id=legacy.default_model_id,
                        default_thinking=legacy.default_thinking,
                        agent_configs={
                            agent_id: AgentModelConfig.model_validate(
                                config.model_dump()
                            )
                            for agent_id, config in legacy.agent_configs.items()
                        },
                    )
                else:
                    catalog = cls.model_validate(values)
            except ValidationError:
                raise DomainError(
                    ErrorCode.INVALID_MODEL_CONFIG, "Invalid model configuration"
                ) from None
            catalog.validate_references()
            return catalog
        provider = ProviderConfig(
            name="Default provider",
            api_type=values.get("api_type", "openai-chat"),
            base_url=values.get("base_url", ""),
            api_key=values.get("api_key", ""),
            extra_body=values.get("extra_body", {}),
        )
        model_name = values.get("model")
        if not model_name:
            return cls(providers=[provider])
        model = RegisteredModel(
            provider_id=provider.id, name=model_name, model=model_name
        )
        return cls(providers=[provider], models=[model], default_model_id=model.id)

    def provider(self, provider_id: str) -> ProviderConfig:
        for provider in self.providers:
            if provider.id == provider_id:
                return provider
        raise DomainError(ErrorCode.PROVIDER_NOT_FOUND, "Provider no longer exists")

    def registered_model(self, model_id: str) -> RegisteredModel:
        for model in self.models:
            if model.id == model_id:
                return model
        raise DomainError(ErrorCode.MODEL_NOT_FOUND, "Model no longer exists")

    def selection(self, agent_id: int | None = None) -> tuple[str | None, Thinking]:
        selection = self.agent_configs.get(str(agent_id), AgentModelConfig())
        return (
            selection.model_id
            if selection.model_id is not None
            else self.default_model_id,
            selection.thinking
            if selection.thinking is not None
            else self.default_thinking,
        )

    def validate_selection(self, selection: AgentModelConfig, owner: str) -> None:
        model_id = (
            selection.model_id
            if selection.model_id is not None
            else self.default_model_id
        )
        thinking = (
            selection.thinking
            if selection.thinking is not None
            else self.default_thinking
        )
        if model_id is None:
            if thinking == "budget":
                raise DomainError(
                    ErrorCode.UNSUPPORTED_THINKING,
                    f"{owner}: select a model with a token budget",
                )
            return
        model = self.registered_model(model_id)
        provider = self.provider(model.provider_id)
        if not model.enabled or not provider.enabled:
            raise DomainError(
                ErrorCode.MODEL_IN_USE,
                f"{owner} references a disabled model or provider",
            )
        options = thinking_options(
            provider.api_type, model.model, model.thinking_budget_tokens
        )
        if thinking not in options:
            raise DomainError(
                ErrorCode.UNSUPPORTED_THINKING,
                f"{owner}: model {model.name} needs a configured token budget for budget selection",
            )

    def validate_references(self) -> None:
        for provider in self.providers:
            validate_request_body(provider.extra_body, provider.api_type)
        if len({item.id for item in self.providers}) != len(self.providers):
            raise DomainError(
                ErrorCode.INVALID_MODEL_CONFIG, "Provider IDs must be unique"
            )
        if len({item.id for item in self.models}) != len(self.models):
            raise DomainError(
                ErrorCode.INVALID_MODEL_CONFIG, "Model IDs must be unique"
            )
        for model in self.models:
            provider = self.provider(model.provider_id)
            if (
                model.thinking_budget_tokens is not None
                and provider.api_type not in BUDGET_API_TYPES
            ):
                raise DomainError(
                    ErrorCode.INVALID_MODEL_CONFIG,
                    f"Model {model.name} budgets require Anthropic or Google",
                )
        self.validate_selection(AgentModelConfig(), "Global default")
        for agent_id, selection in self.agent_configs.items():
            if not agent_id.isdecimal() or int(agent_id) <= 0:
                raise DomainError(ErrorCode.INVALID_MODEL_CONFIG, "Invalid Agent ID")
            self.validate_selection(selection, f"Agent {agent_id}")

    def apply(self, change: dict[str, Any], agent_ids: set[int]) -> ModelCatalog:
        updated = self.model_copy(deep=True)
        action = change.get("action")
        values = dict(change.get("values", {}))
        record_id = change.get("id")
        try:
            if action == "save_provider":
                if record_id is not None:
                    provider = updated.provider(record_id)
                    merged = provider.model_dump()
                    if values.get("api_key") == "":
                        values.pop("api_key")
                    if values.pop("clear_key", False):
                        values["api_key"] = ""
                    merged.update(values)
                    merged["id"] = record_id
                    updated.providers[updated.providers.index(provider)] = (
                        ProviderConfig.model_validate(merged)
                    )
                else:
                    updated.providers.append(ProviderConfig.model_validate(values))
            elif action == "delete_provider":
                if not isinstance(record_id, str):
                    raise DomainError(
                        ErrorCode.INVALID_MODEL_CONFIG, "Provider ID is required"
                    )
                provider = updated.provider(record_id)
                if any(model.provider_id == record_id for model in updated.models):
                    raise DomainError(
                        ErrorCode.PROVIDER_IN_USE,
                        "Remove this provider's models before deleting the provider",
                    )
                updated.providers.remove(provider)
            elif action == "save_model":
                if record_id is not None:
                    model = updated.registered_model(record_id)
                    merged = {**model.model_dump(), **values, "id": record_id}
                    updated.models[updated.models.index(model)] = (
                        RegisteredModel.model_validate(merged)
                    )
                else:
                    updated.models.append(RegisteredModel.model_validate(values))
            elif action == "delete_model":
                if not isinstance(record_id, str):
                    raise DomainError(
                        ErrorCode.INVALID_MODEL_CONFIG, "Model ID is required"
                    )
                model = updated.registered_model(record_id)
                owners = []
                if updated.default_model_id == record_id:
                    owners.append("Global default")
                owners.extend(
                    f"Agent {agent_id}"
                    for agent_id, config in updated.agent_configs.items()
                    if config.model_id == record_id and int(agent_id) in agent_ids
                )
                if owners:
                    raise DomainError(
                        ErrorCode.MODEL_IN_USE, "Model is used by " + ", ".join(owners)
                    )
                updated.models.remove(model)
            elif action == "set_defaults":
                defaults = AgentModelConfig.model_validate(values)
                if defaults.thinking is None:
                    raise DomainError(
                        ErrorCode.INVALID_MODEL_CONFIG,
                        "Global thinking must have an explicit value",
                    )
                updated.default_model_id = defaults.model_id
                updated.default_thinking = defaults.thinking
            elif action == "set_agent":
                if type(record_id) is not int or record_id not in agent_ids:
                    raise DomainError(ErrorCode.NOT_FOUND, "Agent does not exist")
                updated.agent_configs[str(record_id)] = AgentModelConfig.model_validate(
                    values
                )
            else:
                raise DomainError(
                    ErrorCode.INVALID_MODEL_ACTION, "Unknown model configuration action"
                )
        except ValidationError:
            raise DomainError(
                ErrorCode.INVALID_MODEL_CONFIG, "Invalid model configuration fields"
            ) from None
        updated.agent_configs = {
            key: value
            for key, value in updated.agent_configs.items()
            if int(key) in agent_ids
        }
        updated.validate_references()
        updated.validate_selection(AgentModelConfig(), "Global default")
        for agent_id in sorted(agent_ids):
            updated.validate_selection(
                updated.agent_configs.get(str(agent_id), AgentModelConfig()),
                f"Agent {agent_id}",
            )
        return updated

    def redacted(self) -> dict[str, Any]:
        values = self.model_dump(exclude={"providers": {"__all__": {"api_key"}}})
        for model, public in zip(self.models, values["models"], strict=True):
            public["thinking_options"] = thinking_options(
                self.provider(model.provider_id).api_type,
                model.model,
                model.thinking_budget_tokens,
            )
        for provider, public in zip(self.providers, values["providers"], strict=True):
            public["api_key_set"] = bool(provider.api_key)
        return values

    def resolve(self, agent_id: int | None = None) -> ModelConfig:
        model_id, thinking = self.selection(agent_id)
        if model_id is None:
            raise DomainError(
                ErrorCode.MODEL_UNAVAILABLE,
                "Configure a model in Settings before running Agents",
            )
        model = self.registered_model(model_id)
        provider = self.provider(model.provider_id)
        if not model.enabled or not provider.enabled:
            raise DomainError(
                ErrorCode.MODEL_UNAVAILABLE,
                "The selected model or provider is disabled",
            )
        if not provider.base_url.strip():
            raise DomainError(
                ErrorCode.MODEL_UNAVAILABLE,
                f"Provider {provider.name} needs a base URL",
            )
        if not provider.api_key:
            raise DomainError(
                ErrorCode.MODEL_UNAVAILABLE,
                f"Provider {provider.name} needs an API key",
            )
        return ModelConfig(
            api_type=provider.api_type,
            base_url=provider.base_url,
            api_key=provider.api_key,
            model=model.model,
            thinking=thinking,
            thinking_budget_tokens=model.thinking_budget_tokens,
            extra_body=validate_request_body(provider.extra_body, provider.api_type),
            provider_id=provider.id,
            provider_name=provider.name,
            registered_model_id=model.id,
            display_name=model.name,
        )


@dataclass(frozen=True)
class ModelConfig:
    api_type: ApiType
    base_url: str
    api_key: str = field(repr=False)
    model: str
    thinking: Thinking = "default"
    thinking_budget_tokens: int | None = None
    extra_body: dict[str, JsonValue] = field(default_factory=dict)
    provider_id: str | None = None
    provider_name: str | None = None
    registered_model_id: str | None = None
    display_name: str | None = None


def model_settings(config: ModelConfig) -> dict[str, Any]:
    settings = thinking_settings(
        config.api_type, config.model, config.thinking, config.thinking_budget_tokens
    )
    extra_body = validate_request_body(config.extra_body, config.api_type)
    if config.api_type == "openai-chat":
        if "reasoning_effort" in extra_body:
            settings["openai_reasoning_effort"] = extra_body["reasoning_effort"]
        for key in ("max_tokens", "max_completion_tokens"):
            if key in extra_body:
                settings["max_tokens"] = extra_body[key]
    elif config.api_type == "openai-responses":
        if "reasoning" in extra_body:
            reasoning = cast(dict[str, JsonValue], extra_body["reasoning"])
            settings.pop("openai_reasoning_effort", None)
            if "effort" in reasoning:
                settings["openai_reasoning_effort"] = reasoning["effort"]
        if "max_output_tokens" in extra_body:
            settings["max_tokens"] = extra_body["max_output_tokens"]
    elif config.api_type == "anthropic":
        if "thinking" in extra_body:
            settings["anthropic_thinking"] = deepcopy(extra_body["thinking"])
        if "output_config" in extra_body:
            output = cast(dict[str, JsonValue], extra_body["output_config"])
            settings.pop("anthropic_effort", None)
            if "effort" in output:
                settings["anthropic_effort"] = output["effort"]
        if "max_tokens" in extra_body:
            settings["max_tokens"] = extra_body["max_tokens"]
    if extra_body:
        settings["extra_body"] = extra_body
    return settings
