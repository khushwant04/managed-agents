"""Model adapters and model-name resolution.

Model names resolve to an adapter by prefix: ``claude-*`` → ``anthropic``;
``gpt-*``, ``o1``/``o3``/``o4``…, ``codex-*`` → ``openai``. An explicit
``vendor/model`` form always wins (``anthropic/claude-opus-5-5``), and named
OpenAI-compatible endpoints are addressed as ``<endpoint>/<model>``
(``ollama/llama3.3``) once registered.
"""

from __future__ import annotations

import os
import re
from typing import Any

from ..types import CapabilityManifest
from .base import ModelAdapter, ModelError

_OPENAI = re.compile(r"^(gpt-|o\d|codex-|chatgpt-)")


class AdapterRegistry:
    def __init__(self, adapters: dict[str, ModelAdapter] | None = None) -> None:
        self._adapters: dict[str, ModelAdapter] = dict(adapters or {})

    def register(self, name: str, adapter: ModelAdapter) -> None:
        self._adapters[name] = adapter

    def register_compatible(self, name: str, *, base_url: str, api_key: str | None = None) -> None:
        from .openai_compatible import OpenAICompatibleAdapter

        self._adapters[name] = OpenAICompatibleAdapter(base_url=base_url, api_key=api_key or "unused")

    def _get(self, name: str) -> ModelAdapter:
        if name not in self._adapters:
            if name == "anthropic":
                from .anthropic import AnthropicAdapter

                self._adapters[name] = AnthropicAdapter()
            elif name == "openai":
                from .openai import OpenAIAdapter

                self._adapters[name] = OpenAIAdapter()
            elif name == "openai-compatible" and os.environ.get("OPENAI_COMPATIBLE_BASE_URL"):
                self.register_compatible(
                    name,
                    base_url=os.environ["OPENAI_COMPATIBLE_BASE_URL"],
                    api_key=os.environ.get("OPENAI_COMPATIBLE_API_KEY"),
                )
            else:
                raise ModelError("bad_request", f"no adapter registered for {name!r}")
        return self._adapters[name]

    def resolve(self, model: str) -> tuple[ModelAdapter, str]:
        """Return the adapter and the model name to send to it."""
        if model in self._adapters:
            return self._adapters[model], model
        if "/" in model:
            prefix, rest = model.split("/", 1)
            if prefix in self._adapters or prefix in ("anthropic", "openai", "openai-compatible"):
                return self._get(prefix), rest
        if model.startswith("claude-"):
            return self._get("anthropic"), model
        if _OPENAI.match(model):
            return self._get("openai"), model
        raise ModelError("bad_request", f"cannot tell which adapter serves model {model!r}; use vendor/model")

    def capabilities(self, model: str) -> CapabilityManifest:
        adapter, name = self.resolve(model)
        return adapter.capabilities(name)


def default_registry(**adapters: Any) -> AdapterRegistry:
    return AdapterRegistry(adapters)


__all__ = ["AdapterRegistry", "ModelAdapter", "ModelError", "default_registry"]
