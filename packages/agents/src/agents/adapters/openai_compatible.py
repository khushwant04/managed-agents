"""Chat Completions adapter for OpenAI-compatible endpoints (vLLM, Ollama, OpenRouter).

Only tools and streaming are assumed (ADR-0003): every tool, built-ins
included, is a function tool with the canonical schema, and the runtime
executes all of them (ADR-0009). Thinking and vendor blocks from other models
are dropped (ADR-0011); tool calls from any vendor are sent in their canonical
form.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator, Iterable
from typing import Any

from ..types import (
    CapabilityManifest,
    Message,
    ModelDelta,
    ModelRequest,
    ModelResponse,
    ModelStopReason,
    TextBlock,
    TextDelta,
    ToolCallBlock,
    ToolCallDelta,
    ToolResultBlock,
    ToolSpec,
    Usage,
)
from .base import ModelError
from .openai import _CANONICAL_SCHEMAS, _as_dict, _classify

_FINISH_REASONS: dict[str, ModelStopReason] = {
    "stop": "end_turn",
    "tool_calls": "tool_use",
    "function_call": "tool_use",
    "length": "max_tokens",
    "content_filter": "refusal",
}


class OpenAICompatibleAdapter:
    id = "openai-compatible"

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        client: Any | None = None,
        **client_kwargs: Any,
    ) -> None:
        self.base_url = base_url
        self.api_key = api_key
        self._client = client
        self._client_kwargs = client_kwargs

    @property
    def client(self) -> Any:
        if self._client is None:
            import openai

            # Local servers (vLLM, Ollama) ignore the key, but the SDK requires one.
            api_key = self.api_key or os.environ.get("OPENAI_API_KEY") or "unused"
            self._client = openai.AsyncOpenAI(base_url=self.base_url, api_key=api_key, **self._client_kwargs)
        return self._client

    def capabilities(self, model: str) -> CapabilityManifest:
        return CapabilityManifest(
            vendor="openai-compatible",
            model=model,
            tools=True,
            streaming=True,
            parallel_tool_calls=False,
        )

    # -- request building -------------------------------------------------

    def build_params(self, req: ModelRequest) -> dict[str, Any]:
        """Translate a normalized request into Chat Completions parameters (pure)."""
        params: dict[str, Any] = {
            "model": req.model,
            "messages": self._messages(req),
            "max_tokens": req.max_tokens,
            "stream_options": {"include_usage": True},
        }
        if req.tools:
            params["tools"] = [self._tool(t) for t in req.tools]
        params.update(req.options)
        return params

    @staticmethod
    def _tool(spec: ToolSpec) -> dict[str, Any]:
        schema = spec.input_schema
        if spec.kind == "builtin" and spec.name in _CANONICAL_SCHEMAS:
            schema = _CANONICAL_SCHEMAS[spec.name]
        return {
            "type": "function",
            "function": {"name": spec.name, "description": spec.description, "parameters": schema},
        }

    @staticmethod
    def _messages(req: ModelRequest) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if req.system:
            out.append({"role": "system", "content": req.system})
        for msg in req.messages:
            text = "".join(b.text for b in msg.content if isinstance(b, TextBlock))
            if msg.role == "assistant":
                calls = [
                    {
                        "id": b.id,
                        "type": "function",
                        "function": {"name": b.name, "arguments": json.dumps(b.arguments)},
                    }
                    for b in msg.content
                    if isinstance(b, ToolCallBlock)
                ]
                if not text and not calls:
                    continue
                message: dict[str, Any] = {"role": "assistant", "content": text or None}
                if calls:
                    message["tool_calls"] = calls
                out.append(message)
                continue
            # Tool results must directly follow the assistant's tool calls,
            # so they go before any user text in the same message.
            for b in msg.content:
                if isinstance(b, ToolResultBlock):
                    out.append({"role": "tool", "tool_call_id": b.call_id, "content": b.content})
            if text:
                out.append({"role": "user", "content": text})
        return out

    # -- streaming --------------------------------------------------------

    async def stream(self, req: ModelRequest) -> AsyncIterator[ModelDelta]:
        params = self.build_params(req)
        try:
            chunks = await self.client.chat.completions.create(stream=True, **params)
            parser = ChatStreamParser(req.model)
            async for chunk in chunks:
                for delta in parser.feed(_as_dict(chunk)):
                    yield delta
            yield parser.finish()
        except ModelError:
            raise
        except Exception as exc:  # classified below; unknown errors propagate
            raise _classify(exc) from exc


class ChatStreamParser:
    """Accumulates Chat Completions chunks into normalized deltas."""

    def __init__(self, model: str) -> None:
        self.model = model
        self.text: list[str] = []
        self.refusal: list[str] = []
        # Tool calls by their stream index: {"id", "name", "arguments": [..]}.
        self.calls: dict[int, dict[str, Any]] = {}
        self.finish_reason: str | None = None
        self.usage = Usage()

    def feed(self, chunk: dict[str, Any]) -> Iterable[ModelDelta]:
        self.model = chunk.get("model") or self.model
        if chunk.get("usage"):
            self._usage(chunk["usage"])
        for choice in chunk.get("choices") or []:
            if choice.get("index", 0) != 0:
                continue
            delta = choice.get("delta") or {}
            if delta.get("content"):
                self.text.append(delta["content"])
                yield TextDelta(text=delta["content"])
            if delta.get("refusal"):
                self.refusal.append(delta["refusal"])
                yield TextDelta(text=delta["refusal"])
            for tc in delta.get("tool_calls") or []:
                index = tc.get("index", 0)
                call = self.calls.setdefault(index, {"id": None, "name": None, "arguments": [], "announced": False})
                fn = tc.get("function") or {}
                call["id"] = call["id"] or tc.get("id")
                call["name"] = call["name"] or fn.get("name")
                if fn.get("arguments"):
                    call["arguments"].append(fn["arguments"])
                if call["name"] and not call["announced"]:
                    call["announced"] = True
                    call["id"] = call["id"] or f"call_{index}"
                    yield ToolCallDelta(id=call["id"], name=call["name"])
            if choice.get("finish_reason"):
                self.finish_reason = choice["finish_reason"]

    def _usage(self, usage: dict[str, Any]) -> None:
        details = usage.get("prompt_tokens_details") or {}
        cached = details.get("cached_tokens") or 0
        written = details.get("cache_write_tokens") or 0
        # prompt_tokens include cached tokens; normalized usage counts them separately.
        self.usage = Usage(
            input_tokens=max((usage.get("prompt_tokens") or 0) - cached - written, 0),
            output_tokens=usage.get("completion_tokens") or 0,
            cache_read_tokens=cached,
            cache_write_tokens=written,
        )

    def finish(self) -> ModelResponse:
        content: list[Any] = []
        text = "".join(self.text) + "".join(self.refusal)
        if text:
            content.append(TextBlock(text=text))
        for index in sorted(self.calls):
            call = self.calls[index]
            raw_args = "".join(call["arguments"])
            parse_error = None
            try:
                args = json.loads(raw_args) if raw_args.strip() else {}
            except json.JSONDecodeError as exc:
                args, parse_error = {}, f"INVALID_JSON: {exc.msg}"
            if not isinstance(args, dict):
                args, parse_error = {}, parse_error or "INVALID_JSON: arguments are not an object"
            content.append(
                ToolCallBlock(
                    id=call["id"] or f"call_{index}",
                    name=call["name"] or "",
                    native_name=call["name"],
                    arguments=args,
                    vendor="openai-compatible",
                    parse_error=parse_error,
                )
            )
        stop = _FINISH_REASONS.get(self.finish_reason or "", "end_turn")
        # Some servers report "stop" even when the turn ends in tool calls.
        if stop == "end_turn" and self.calls:
            stop = "tool_use"
        if stop == "end_turn" and self.refusal:
            stop = "refusal"
        return ModelResponse(
            message=Message(role="assistant", content=content),
            stop_reason=stop,
            usage=self.usage,
            model=self.model,
            refusal_category="content_filter" if self.finish_reason == "content_filter" else None,
        )
