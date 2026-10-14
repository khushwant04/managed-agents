"""Anthropic Messages API adapter.

Native features exposed (ADR-0003): adaptive thinking with effort, prompt
caching (5 minute or 1 hour), server-side web search and web fetch, native
compaction (opt-in), and the server-side refusal fallback. The portable
``shell`` and ``files`` built-ins are presented as Claude's bash and text
editor tools and executed in our sandbox (ADR-0009).

Thinking blocks are passed back unchanged to every Claude model (the API drops
what a target model can't read, and stripping them can cause ordering or
signature errors); they are dropped only when the conversation crosses to
another vendor (ADR-0011). The transcript is only ever appended to.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterable
from typing import Any

from ..tools.builtins import CODE_SCHEMA
from ..types import (
    CapabilityManifest,
    Message,
    ModelDelta,
    ModelRequest,
    ModelResponse,
    ModelStopReason,
    TextBlock,
    TextDelta,
    ThinkingBlock,
    ThinkingDelta,
    ToolCallBlock,
    ToolCallDelta,
    ToolResultBlock,
    ToolSpec,
    Usage,
    VendorBlock,
)
from .base import ModelError

BASH_NAME = "bash"
EDITOR_NAME = "str_replace_based_edit_tool"
NATIVE_TO_CANONICAL = {BASH_NAME: "shell", EDITOR_NAME: "files"}

# Models whose effort parameter, adaptive thinking and 1M context we rely on.
_ADAPTIVE_PREFIXES = (
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-5",
)
# Models that take the dynamic-filtering web tool variants.
_DYNAMIC_WEB_PREFIXES = (
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
)
# Models that accept `fallbacks: "default"` (server-side refusal fallback).
_SERVER_FALLBACK_MODELS = frozenset(
    {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}
)
SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01"
COMPACTION_BETA = "compact-2026-01-12"

_EFFORT = {"low": "low", "medium": "medium", "high": "high"}
_LEGACY_BUDGET = {"low": 2048, "medium": 8192, "high": 24000}
_CONSUMED_OPTIONS = {"cache", "compaction", "server_fallbacks", "effort"}

_STOP_REASONS: dict[str, ModelStopReason] = {
    "end_turn": "end_turn",
    "stop_sequence": "end_turn",
    "tool_use": "tool_use",
    "max_tokens": "max_tokens",
    "model_context_window_exceeded": "max_tokens",
    "pause_turn": "pause_turn",
    "refusal": "refusal",
}


def _is_adaptive(model: str) -> bool:
    return model.startswith(_ADAPTIVE_PREFIXES)


class AnthropicAdapter:
    id = "anthropic"

    def __init__(self, client: Any | None = None, **client_kwargs: Any) -> None:
        self._client = client
        self._client_kwargs = client_kwargs

    @property
    def client(self) -> Any:
        if self._client is None:
            import anthropic

            self._client = anthropic.AsyncAnthropic(**self._client_kwargs)
        return self._client

    # -- capabilities -----------------------------------------------------

    def capabilities(self, model: str) -> CapabilityManifest:
        adaptive = _is_adaptive(model)
        legacy_200k = model.startswith(("claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"))
        return CapabilityManifest(
            vendor="anthropic",
            model=model,
            reasoning=True,
            thinking_visible=True,
            prompt_caching=True,
            server_web_search=True,
            server_web_fetch=not model.startswith("claude-haiku-4-5"),
            native_compaction=adaptive,
            structured_outputs=True,
            vision=True,
            context_window=200_000 if legacy_200k else 1_000_000,
            max_output_tokens=64_000 if legacy_200k else 128_000,
            non_zdr_features=["code_execution", "files_api", "agent_skills", "mcp_connector"]
            + (["model_requires_retention"] if model.startswith("claude-fable-5-1") else []),
        )

    # -- request building -------------------------------------------------

    def build_params(self, req: ModelRequest) -> dict[str, Any]:
        """Translate a normalized request into Messages API parameters (pure)."""
        opts = dict(req.options)
        manifest = self.capabilities(req.model)
        params: dict[str, Any] = {
            "model": req.model,
            "max_tokens": min(req.max_tokens, manifest.max_output_tokens or req.max_tokens),
            "messages": self._messages(req),
        }
        betas: list[str] = []
        if req.system:
            params["system"] = [{"type": "text", "text": req.system}]
        if req.tools:
            params["tools"] = [self._tool(t, req.model) for t in req.tools]

        if _is_adaptive(req.model):
            params["thinking"] = {"type": "adaptive", "display": "summarized"}
            effort = opts.get("effort") or (_EFFORT[req.reasoning] if req.reasoning else None)
            if effort:
                params["output_config"] = {"effort": effort}
        elif req.reasoning:
            budget = min(_LEGACY_BUDGET[req.reasoning], params["max_tokens"] - 1)
            params["thinking"] = {"type": "enabled", "budget_tokens": budget}

        cache = opts.get("cache", "5m")
        if cache not in (False, None, "off"):
            cache_control: dict[str, Any] = {"type": "ephemeral"}
            if cache == "1h":
                cache_control["ttl"] = "1h"
            params["cache_control"] = cache_control

        if opts.get("server_fallbacks", True) and req.model in _SERVER_FALLBACK_MODELS:
            betas.append(SERVER_FALLBACK_BETA)
            params["fallbacks"] = "default"

        if opts.get("compaction") and manifest.native_compaction:
            betas.append(COMPACTION_BETA)
            params["context_management"] = {"edits": [{"type": "compact_20260112"}]}

        params.update({k: v for k, v in opts.items() if k not in _CONSUMED_OPTIONS})
        if betas:
            params["betas"] = betas
        return params

    def _tool(self, spec: ToolSpec, model: str) -> dict[str, Any]:
        if spec.kind == "builtin":
            if spec.name == "shell":
                return {"type": "bash_20250124", "name": BASH_NAME}
            if spec.name == "files":
                return {"type": "text_editor_20250728", "name": EDITOR_NAME}
            if spec.name == "code":
                return self._function("code", spec.description, CODE_SCHEMA)
            if spec.name in ("web_search", "web_fetch"):
                dynamic = model.startswith(_DYNAMIC_WEB_PREFIXES)
                version = {
                    "web_search": "web_search_20260209" if dynamic else "web_search_20250305",
                    "web_fetch": "web_fetch_20260209" if dynamic else "web_fetch_20250910",
                }[spec.name]
                tool: dict[str, Any] = {"type": version, "name": spec.name}
                for key in ("allowed_domains", "blocked_domains", "max_uses"):
                    if key in spec.options:
                        tool[key] = spec.options[key]
                return tool
        return self._function(spec.name, spec.description, spec.input_schema)

    @staticmethod
    def _function(name: str, description: str, schema: dict[str, Any]) -> dict[str, Any]:
        return {
            "name": name,
            "description": description,
            "input_schema": schema,
            "eager_input_streaming": True,
        }

    def _messages(self, req: ModelRequest) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for msg in req.messages:
            content = [c for b in msg.content if (c := self._block(b, req.model)) is not None]
            if not content:
                continue
            if out and out[-1]["role"] == msg.role:
                out[-1]["content"].extend(content)
            else:
                out.append({"role": msg.role, "content": content})
        return out

    def _block(self, block: Any, model: str) -> dict[str, Any] | None:
        if isinstance(block, TextBlock):
            return {"type": "text", "text": block.text} if block.text else None
        if isinstance(block, ThinkingBlock):
            # Echo unchanged within the vendor; drop when crossing vendors.
            return block.raw if block.vendor == "anthropic" and block.raw else None
        if isinstance(block, ToolCallBlock):
            name, args = self._native_call(block)
            return {"type": "tool_use", "id": block.id, "name": name, "input": args}
        if isinstance(block, ToolResultBlock):
            return {
                "type": "tool_result",
                "tool_use_id": block.call_id,
                "content": block.content,
                "is_error": block.is_error,
            }
        if isinstance(block, VendorBlock):
            return block.raw if block.vendor == "anthropic" else None
        raise TypeError(f"unsupported block {block!r}")

    @staticmethod
    def _native_call(block: ToolCallBlock) -> tuple[str, dict[str, Any]]:
        if block.vendor == "anthropic" and block.native_name:
            return block.native_name, block.raw.get("input", block.arguments)
        if block.name == "shell":
            command = block.arguments.get("command", "")
            return BASH_NAME, {"command": command}
        if block.name == "files":
            return EDITOR_NAME, dict(block.arguments)
        return block.name, dict(block.arguments)

    # -- streaming --------------------------------------------------------

    async def stream(self, req: ModelRequest) -> AsyncIterator[ModelDelta]:
        params = self.build_params(req)
        try:
            events = await self.client.beta.messages.create(stream=True, **params)
            parser = StreamParser(req.model)
            async for event in events:
                for delta in parser.feed(_as_dict(event)):
                    yield delta
            yield parser.finish()
        except ModelError:
            raise
        except Exception as exc:  # classified below; unknown errors propagate
            raise _classify(exc) from exc


def _as_dict(event: Any) -> dict[str, Any]:
    if isinstance(event, dict):
        return event
    for attr in ("to_dict", "model_dump"):
        fn = getattr(event, attr, None)
        if fn is not None:
            return fn()
    raise TypeError(f"cannot read stream event {event!r}")


def _classify(exc: Exception) -> Exception:
    try:
        import anthropic
    except ImportError:  # pragma: no cover
        return exc
    if isinstance(exc, anthropic.RateLimitError):
        return ModelError("rate_limit", str(exc), status=429)
    if isinstance(exc, anthropic.AuthenticationError | anthropic.PermissionDeniedError):
        return ModelError("auth", str(exc), status=exc.status_code)
    if isinstance(exc, anthropic.APIStatusError):
        kind = "server" if exc.status_code >= 500 else "bad_request"
        return ModelError(kind, str(exc), status=exc.status_code)
    if isinstance(exc, anthropic.APIConnectionError):
        return ModelError("connection", str(exc))
    return exc


class StreamParser:
    """Accumulates raw Messages API stream events into normalized deltas."""

    def __init__(self, model: str) -> None:
        self.model = model
        self.blocks: dict[int, dict[str, Any]] = {}
        self.partial_json: dict[int, list[str]] = {}
        self.stop_reason: str | None = None
        self.refusal_category: str | None = None
        self.usage = Usage()

    def feed(self, event: dict[str, Any]) -> Iterable[ModelDelta]:
        etype = event.get("type")
        if etype == "message_start":
            message = event.get("message", {})
            self.model = message.get("model") or self.model
            self._usage(message.get("usage") or {})
        elif etype == "content_block_start":
            index = event["index"]
            block = dict(event["content_block"])
            self.blocks[index] = block
            if block.get("type") in ("tool_use", "server_tool_use"):
                self.partial_json[index] = []
                if block.get("type") == "tool_use":
                    yield ToolCallDelta(id=block["id"], name=NATIVE_TO_CANONICAL.get(block["name"], block["name"]))
            if block.get("type") == "fallback":
                to = block.get("to") or {}
                self.model = to.get("model") or self.model
        elif etype == "content_block_delta":
            index = event["index"]
            block = self.blocks.setdefault(index, {"type": "unknown"})
            delta = event["delta"]
            dtype = delta.get("type")
            if dtype == "text_delta":
                block["text"] = block.get("text", "") + delta["text"]
                yield TextDelta(text=delta["text"])
            elif dtype == "thinking_delta":
                block["thinking"] = block.get("thinking", "") + delta["thinking"]
                yield ThinkingDelta(text=delta["thinking"])
            elif dtype == "signature_delta":
                block["signature"] = block.get("signature", "") + delta["signature"]
            elif dtype == "input_json_delta":
                self.partial_json.setdefault(index, []).append(delta.get("partial_json", ""))
            elif dtype == "citations_delta":
                block.setdefault("citations", []).append(delta.get("citation"))
            else:
                for key, value in delta.items():
                    if key != "type" and isinstance(value, str):
                        block[key] = block.get(key, "") + value
        elif etype == "message_delta":
            delta = event.get("delta") or {}
            self.stop_reason = delta.get("stop_reason") or self.stop_reason
            details = delta.get("stop_details") or {}
            self.refusal_category = details.get("category") or self.refusal_category
            self._usage(event.get("usage") or {})
        elif etype == "error":
            err = event.get("error") or {}
            kind = "server" if err.get("type") in ("overloaded_error", "api_error") else "bad_request"
            raise ModelError(kind, err.get("message", "stream error"))
        return

    def _usage(self, usage: dict[str, Any]) -> None:
        if usage.get("input_tokens") is not None:
            self.usage.input_tokens = usage["input_tokens"]
        if usage.get("output_tokens") is not None:
            self.usage.output_tokens = usage["output_tokens"]
        if usage.get("cache_read_input_tokens") is not None:
            self.usage.cache_read_tokens = usage["cache_read_input_tokens"]
        if usage.get("cache_creation_input_tokens") is not None:
            self.usage.cache_write_tokens = usage["cache_creation_input_tokens"]

    def finish(self) -> ModelResponse:
        content: list[Any] = []
        order = sorted(self.blocks)
        # After a mid-output server-side fallback, only text and paired
        # server-tool blocks before the last `fallback` marker are echoed back.
        fallback_at = max((i for i in order if self.blocks[i].get("type") == "fallback"), default=-1)
        paired = {
            b.get("tool_use_id") for b in self.blocks.values() if b.get("type", "").endswith("_tool_result")
        }
        for index in order:
            block = self.blocks[index]
            btype = block.get("type") or ""
            if index < fallback_at and not (
                btype == "text"
                or btype.endswith("_tool_result")
                or (btype == "server_tool_use" and block.get("id") in paired)
            ):
                continue
            if index in self.partial_json:
                raw_json = "".join(self.partial_json[index])
                try:
                    block["input"] = json.loads(raw_json) if raw_json else block.get("input") or {}
                    parse_error = None
                except json.JSONDecodeError as exc:
                    block["input"] = {}
                    parse_error = f"INVALID_JSON: {exc.msg}"
            else:
                parse_error = None
            if btype == "text":
                content.append(TextBlock(text=block.get("text", "")))
            elif btype in ("thinking", "redacted_thinking"):
                content.append(
                    ThinkingBlock(text=block.get("thinking", ""), vendor="anthropic", model=self.model, raw=block)
                )
            elif btype == "tool_use":
                args = block.get("input")
                if not isinstance(args, dict):
                    args, parse_error = {}, parse_error or "tool input is not an object"
                content.append(
                    ToolCallBlock(
                        id=block["id"],
                        name=NATIVE_TO_CANONICAL.get(block["name"], block["name"]),
                        native_name=block["name"],
                        arguments=args,
                        vendor="anthropic",
                        raw={"input": args},
                        parse_error=parse_error,
                    )
                )
            elif btype == "fallback":
                continue
            else:
                content.append(VendorBlock(vendor="anthropic", model=self.model, raw=block))
        stop = _STOP_REASONS.get(self.stop_reason or "", "end_turn")
        return ModelResponse(
            message=Message(role="assistant", content=content),
            stop_reason=stop,
            usage=self.usage,
            model=self.model,
            refusal_category=self.refusal_category if stop == "refusal" else None,
        )
