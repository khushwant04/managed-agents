"""Test helpers: run agents without API keys.

- ``ScriptedAdapter`` plays back a list of model turns, for runtime tests.
- ``RecordedStream`` / ``FakeAnthropicClient`` replay recorded raw vendor
  stream events through the real adapters, for adapter contract tests.
- ``scripted_registry`` wires a ``ScriptedAdapter`` in for any model name.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

from ..adapters import AdapterRegistry
from ..adapters.base import ModelError
from ..events import new_id
from ..types import (
    CapabilityManifest,
    Message,
    ModelDelta,
    ModelRequest,
    ModelResponse,
    TextBlock,
    TextDelta,
    ToolCallBlock,
    ToolCallDelta,
    Usage,
)

Turn = ModelResponse | ModelError | Callable[[ModelRequest], "ModelResponse | ModelError"]


def text(content: str, *, usage: Usage | None = None, model: str = "scripted") -> ModelResponse:
    return ModelResponse(
        message=Message(role="assistant", content=[TextBlock(text=content)]),
        stop_reason="end_turn",
        usage=usage or Usage(input_tokens=10, output_tokens=5),
        model=model,
    )


def call(name: str, arguments: dict[str, Any] | None = None, *, id: str | None = None, say: str = "", model: str = "scripted") -> ModelResponse:
    return calls([(name, arguments or {})], ids=[id] if id else None, say=say, model=model)


def calls(
    items: list[tuple[str, dict[str, Any]]], *, ids: list[str] | None = None, say: str = "", model: str = "scripted"
) -> ModelResponse:
    content: list[Any] = [TextBlock(text=say)] if say else []
    for i, (name, args) in enumerate(items):
        content.append(ToolCallBlock(id=(ids[i] if ids else new_id("call")), name=name, arguments=args))
    return ModelResponse(
        message=Message(role="assistant", content=content),
        stop_reason="tool_use",
        usage=Usage(input_tokens=10, output_tokens=5),
        model=model,
    )


class ScriptedAdapter:
    """Returns pre-scripted turns in order and records every request."""

    id = "anthropic"

    def __init__(self, turns: list[Turn], *, manifest: dict[str, Any] | None = None) -> None:
        self.turns = list(turns)
        self.requests: list[ModelRequest] = []
        self.manifest = manifest or {}

    def capabilities(self, model: str) -> CapabilityManifest:
        return CapabilityManifest(vendor=self.id, model=model, context_window=1_000_000, **self.manifest)  # type: ignore[arg-type]

    async def stream(self, req: ModelRequest) -> AsyncIterator[ModelDelta]:
        self.requests.append(req)
        if not self.turns:
            raise AssertionError(f"ScriptedAdapter ran out of turns (request #{len(self.requests)})")
        turn = self.turns.pop(0)
        if callable(turn) and not isinstance(turn, ModelResponse | ModelError):
            turn = turn(req)
        if isinstance(turn, ModelError):
            raise turn
        if turn.message.text:
            for word in turn.message.text.split(" "):
                yield TextDelta(text=word + " ")
        for c in turn.message.tool_calls:
            yield ToolCallDelta(id=c.id, name=c.name)
        yield turn.model_copy(update={"model": req.model if turn.model == "scripted" else turn.model})


def scripted_registry(*adapters: ScriptedAdapter) -> AdapterRegistry:
    """Route model ``scripted`` (or ``scripted-N``) to the given adapters."""
    reg = AdapterRegistry()
    for i, a in enumerate(adapters):
        reg.register(f"scripted-{i}" if i else "scripted", a)
    return reg


class RecordedStream:
    """An async iterator over recorded raw stream events."""

    def __init__(self, events: list[dict[str, Any]]) -> None:
        self._events = list(events)

    def __aiter__(self) -> RecordedStream:
        return self

    async def __anext__(self) -> dict[str, Any]:
        if not self._events:
            raise StopAsyncIteration
        return self._events.pop(0)


def load_fixture(path: str | Path) -> list[dict[str, Any]]:
    return json.loads(Path(path).read_text())


class _Messages:
    def __init__(self, owner: FakeAnthropicClient) -> None:
        self.owner = owner

    async def create(self, **params: Any) -> Any:
        self.owner.calls.append(params)
        item = self.owner.streams.pop(0)
        if isinstance(item, Exception):
            raise item
        return RecordedStream(item)


class FakeAnthropicClient:
    """Stands in for ``anthropic.AsyncAnthropic``; ``beta.messages.create`` replays streams."""

    def __init__(self, streams: list[list[dict[str, Any]] | Exception]) -> None:
        self.streams = list(streams)
        self.calls: list[dict[str, Any]] = []
        self.beta = type("Beta", (), {})()
        self.beta.messages = _Messages(self)
        self.messages = self.beta.messages
