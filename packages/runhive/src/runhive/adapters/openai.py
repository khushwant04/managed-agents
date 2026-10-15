"""OpenAI Responses API adapter.

Native features exposed (ADR-0003): reasoning effort with streamed reasoning
summaries, automatic prompt caching (``prompt_cache_key`` passes through),
server-side web search, the native shell tool and native compaction (opt-in).
The portable ``shell`` built-in is presented as OpenAI's shell tool with a
local environment, so the model emits ``shell_call`` items that our sandbox
executes (ADR-0009); ``files``, ``code`` and ``web_fetch`` are function tools
with the canonical schemas.

The runtime owns the transcript (ADR-0011): every call sends the full input
with ``store=False`` and never uses ``previous_response_id``. Reasoning items
are requested with ``reasoning.encrypted_content`` so they can round-trip
statelessly; they are kept as ``ThinkingBlock(vendor="openai")`` and echoed
only to OpenAI models, as are other OpenAI-only items (web search calls,
compaction items), which are kept as ``VendorBlock``.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterable
from typing import Any

from ..tools.builtins import (
    CODE_SCHEMA,
    FILES_SCHEMA,
    SHELL_SCHEMA,
    WEB_FETCH_SCHEMA,
    WEB_SEARCH_SCHEMA,
)
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
from .base import ModelError, ModelErrorKind

# `native_name` of a call made through the native shell tool. The function
# tool presenting `shell` to other models is plain "shell".
SHELL_CALL = "shell_call"

_CANONICAL_SCHEMAS = {
    "shell": SHELL_SCHEMA,
    "files": FILES_SCHEMA,
    "code": CODE_SCHEMA,
    "web_search": WEB_SEARCH_SCHEMA,
    "web_fetch": WEB_FETCH_SCHEMA,
}

# Static capability table, longest prefix wins. Context and output sizes are
# approximate (from OpenAI's model pages, not the SDK) and only used for
# registration checks and clamping `max_output_tokens`.
# (prefix, reasoning, vision, context_window, max_output_tokens)
_MODELS: tuple[tuple[str, bool, bool, int, int], ...] = (
    ("gpt-6", True, True, 1_050_000, 128_000),
    ("gpt-5.6", True, True, 1_050_000, 128_000),
    ("gpt-5.5", True, True, 1_050_000, 128_000),
    ("gpt-5.4", True, True, 1_050_000, 128_000),
    ("gpt-5", True, True, 400_000, 128_000),
    ("o4", True, True, 200_000, 100_000),
    ("o3", True, True, 200_000, 100_000),
    ("o1", True, True, 200_000, 100_000),
    ("gpt-4.1", False, True, 1_047_576, 32_768),
    ("gpt-4o", False, True, 128_000, 16_384),
)
# Models trained on the native shell tool. Not stated in the SDK; override per
# agent with `model_options["openai"]["native_shell"]`.
_NATIVE_SHELL_PREFIXES = ("gpt-5.1", "gpt-5.2", "gpt-5.3", "gpt-5.4", "gpt-5.5", "gpt-5.6", "gpt-6")

_CONSUMED_OPTIONS = {"effort", "summary", "compaction", "native_shell"}
# Options that would hand transcript ownership to OpenAI (ADR-0011) or are
# out of scope; rejected rather than silently ignored (ADR-0003).
_REJECTED_OPTIONS = {"background", "previous_response_id", "conversation", "store", "stream", "input"}

# Fields each echoed item type accepts as input (response_input_item_param.py,
# response_function_tool_call_param.py, response_reasoning_item_param.py).
_INPUT_KEYS = {
    "reasoning": {"type", "id", "summary", "content", "encrypted_content", "status"},
    "function_call": {"type", "id", "call_id", "name", "arguments", "namespace", "caller", "status"},
    "shell_call": {"type", "id", "call_id", "action", "caller", "environment", "status"},
}

# Response error codes (`ResponseError.code`) and stream error codes.
_REFUSAL_CODES = {"bio_policy", "misalignment_policy_violation", "image_content_policy_violation"}
_SERVER_CODES = {"server_error", "vector_store_timeout"}


def _model_row(model: str) -> tuple[str, bool, bool, int, int] | None:
    for row in _MODELS:
        if model.startswith(row[0]):
            return row
    return None


def _is_reasoning(model: str) -> bool:
    row = _model_row(model)
    return bool(row and row[1]) and "chat-latest" not in model


class OpenAIAdapter:
    id = "openai"

    def __init__(self, client: Any | None = None, **client_kwargs: Any) -> None:
        self._client = client
        self._client_kwargs = client_kwargs

    @property
    def client(self) -> Any:
        if self._client is None:
            import openai

            self._client = openai.AsyncOpenAI(**self._client_kwargs)
        return self._client

    # -- capabilities -----------------------------------------------------

    def capabilities(self, model: str) -> CapabilityManifest:
        row = _model_row(model)
        if row is None:
            # Unknown model: claim only what every Responses model serves.
            return CapabilityManifest(vendor="openai", model=model)
        _, _, vision, context_window, max_output = row
        reasoning = _is_reasoning(model)
        return CapabilityManifest(
            vendor="openai",
            model=model,
            reasoning=reasoning,
            thinking_visible=reasoning,  # reasoning summaries, not raw reasoning
            prompt_caching=True,  # automatic prefix caching
            server_web_search=True,
            server_web_fetch=False,
            # Documented here as gpt-5 and later (`context_management` compaction).
            native_compaction=model.startswith(("gpt-5", "gpt-6")),
            structured_outputs=True,
            vision=vision,
            context_window=context_window,
            max_output_tokens=max_output,
        )

    # -- request building -------------------------------------------------

    def build_params(self, req: ModelRequest) -> dict[str, Any]:
        """Translate a normalized request into Responses API parameters (pure)."""
        opts = dict(req.options)
        rejected = sorted(_REJECTED_OPTIONS & opts.keys())
        if rejected:
            raise ModelError(
                "bad_request",
                f"model_options['openai'] {rejected} not supported: the runtime owns the transcript",
            )
        manifest = self.capabilities(req.model)
        native_shell = self._native_shell(req, opts)
        params: dict[str, Any] = {
            "model": req.model,
            "input": self._input(req, native_shell),
            "store": False,
            "max_output_tokens": min(req.max_tokens, manifest.max_output_tokens or req.max_tokens),
        }
        if req.system:
            params["instructions"] = req.system
        if req.tools:
            params["tools"] = [self._tool(t, native_shell) for t in req.tools]

        include: list[str] = list(opts.pop("include", None) or [])
        if manifest.reasoning:
            reasoning: dict[str, Any] = {"summary": opts.get("summary", "auto")}
            effort = opts.get("effort") or req.reasoning
            if effort:
                reasoning["effort"] = effort
            params["reasoning"] = reasoning
            if "reasoning.encrypted_content" not in include:
                include.append("reasoning.encrypted_content")
        if include:
            params["include"] = include

        compaction = opts.get("compaction")
        if compaction and manifest.native_compaction:
            entry: dict[str, Any] = {"type": "compaction"}
            if isinstance(compaction, int) and not isinstance(compaction, bool):
                entry["compact_threshold"] = compaction
            params["context_management"] = [entry]

        params.update({k: v for k, v in opts.items() if k not in _CONSUMED_OPTIONS})
        return params

    def _native_shell(self, req: ModelRequest, opts: dict[str, Any]) -> bool:
        if not any(t.kind == "builtin" and t.name == "shell" for t in req.tools):
            return False
        if "native_shell" in opts:
            return bool(opts["native_shell"])
        return req.model.startswith(_NATIVE_SHELL_PREFIXES)

    def _tool(self, spec: ToolSpec, native_shell: bool) -> dict[str, Any]:
        if spec.kind == "builtin":
            if spec.name == "shell" and native_shell:
                # Local environment: the model emits shell_call items and the
                # client (our sandbox) runs them; no hosted container.
                return {"type": "shell", "environment": {"type": "local"}}
            if spec.name == "web_search" and "blocked_domains" not in spec.options:
                # OpenAI's tool has no block list; with one, fall back to ours.
                tool: dict[str, Any] = {"type": "web_search"}
                if "allowed_domains" in spec.options:
                    tool["filters"] = {"allowed_domains": list(spec.options["allowed_domains"])}
                for key in ("search_context_size", "user_location", "external_web_access"):
                    if key in spec.options:
                        tool[key] = spec.options[key]
                return tool
            if spec.name in _CANONICAL_SCHEMAS:
                return _function(spec.name, spec.description, _CANONICAL_SCHEMAS[spec.name])
        return _function(spec.name, spec.description, spec.input_schema)

    def _input(self, req: ModelRequest, native_shell: bool) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        # call_id -> shell_call item, so results go back in the matching shape.
        shell_calls: dict[str, dict[str, Any]] = {}
        for msg in req.messages:
            texts: list[str] = []
            for block in msg.content:
                if isinstance(block, TextBlock):
                    phase = block.raw.get("phase") if block.vendor == "openai" else None
                    if phase and msg.role == "assistant":
                        # Resend phase on assistant messages, as the API asks.
                        _flush_text(items, msg.role, texts)
                        items.append({"type": "message", "role": "assistant", "content": block.text, "phase": phase})
                    elif block.text:
                        texts.append(block.text)
                    continue
                _flush_text(items, msg.role, texts)
                if isinstance(block, ThinkingBlock):
                    # Without encrypted content a stateless reasoning item
                    # would reference server state we never stored.
                    if block.vendor == "openai" and block.raw.get("encrypted_content"):
                        items.append(_echo(block.raw))
                elif isinstance(block, ToolCallBlock):
                    item = self._call_item(block, native_shell)
                    if item["type"] == "shell_call":
                        shell_calls[block.id] = item
                    items.append(item)
                elif isinstance(block, ToolResultBlock):
                    items.append(self._result_item(block, shell_calls.get(block.call_id)))
                elif isinstance(block, VendorBlock):
                    if block.vendor == "openai":
                        items.append(_echo(block.raw))
                else:
                    raise TypeError(f"unsupported block {block!r}")
            _flush_text(items, msg.role, texts)
        return items

    @staticmethod
    def _call_item(block: ToolCallBlock, native_shell: bool) -> dict[str, Any]:
        raw_type = block.raw.get("type") if block.vendor == "openai" else None
        if native_shell and block.name == "shell":
            if raw_type == "shell_call":
                return _echo(block.raw)
            # Another vendor's (or a function-style) shell call, as a native call.
            action: dict[str, Any] = {"commands": [str(block.arguments.get("command", ""))]}
            if block.arguments.get("timeout") is not None:
                action["timeout_ms"] = int(float(block.arguments["timeout"]) * 1000)
            return {"type": "shell_call", "call_id": block.id, "action": action, "status": "completed"}
        if raw_type == "function_call":
            return _echo(block.raw)
        return {
            "type": "function_call",
            "call_id": block.id,
            "name": block.name,
            "arguments": json.dumps(block.arguments),
        }

    @staticmethod
    def _result_item(block: ToolResultBlock, shell_call: dict[str, Any] | None) -> dict[str, Any]:
        if shell_call is None:
            return {"type": "function_call_output", "call_id": block.call_id, "output": block.content}
        # The transcript keeps one combined output string and an error flag.
        item: dict[str, Any] = {
            "type": "shell_call_output",
            "call_id": block.call_id,
            "output": [
                {
                    "stdout": block.content,
                    "stderr": "",
                    "outcome": {"type": "exit", "exit_code": 1 if block.is_error else 0},
                }
            ],
        }
        max_len = (shell_call.get("action") or {}).get("max_output_length")
        if max_len is not None:
            item["max_output_length"] = max_len
        return item

    # -- streaming --------------------------------------------------------

    async def stream(self, req: ModelRequest) -> AsyncIterator[ModelDelta]:
        params = self.build_params(req)
        try:
            events = await self.client.responses.create(stream=True, **params)
            parser = StreamParser(req.model)
            async for event in events:
                for delta in parser.feed(_as_dict(event)):
                    yield delta
            yield parser.finish()
        except ModelError:
            raise
        except Exception as exc:  # classified below; unknown errors propagate
            raise _classify(exc) from exc


def _function(name: str, description: str, schema: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "function",
        "name": name,
        "description": description,
        "parameters": schema,
        "strict": False,
    }


def _as_dict(event: Any) -> dict[str, Any]:
    if isinstance(event, dict):
        return event
    for attr in ("to_dict", "model_dump"):
        fn = getattr(event, attr, None)
        if fn is not None:
            return fn()
    raise TypeError(f"cannot read stream event {event!r}")


def _clean(item: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in item.items() if v is not None}


def _echo(item: dict[str, Any]) -> dict[str, Any]:
    """An output item as an input item: nulls and output-only fields removed."""
    keys = _INPUT_KEYS.get(item.get("type", ""))
    return {k: v for k, v in item.items() if v is not None and (keys is None or k in keys)}


def _flush_text(items: list[dict[str, Any]], role: str, texts: list[str]) -> None:
    if not texts:
        return
    if role == "user":
        content: Any = [{"type": "input_text", "text": t} for t in texts]
    else:
        content = "".join(texts)
    items.append({"type": "message", "role": role, "content": content})
    texts.clear()


def _code_kind(code: str | None) -> ModelErrorKind:
    code = code or ""
    if "rate_limit" in code:
        return "rate_limit"
    if code in _REFUSAL_CODES:
        return "refusal"
    if code in _SERVER_CODES or not code:
        return "server"
    return "bad_request"


def _classify(exc: Exception) -> Exception:
    """Map ``openai`` SDK exceptions to ``ModelError`` (shared with openai-compatible)."""
    try:
        import openai
    except ImportError:  # pragma: no cover
        return exc
    if isinstance(exc, openai.RateLimitError):
        return ModelError("rate_limit", str(exc), status=429)
    if isinstance(exc, openai.AuthenticationError | openai.PermissionDeniedError):
        return ModelError("auth", str(exc), status=exc.status_code)
    if isinstance(exc, openai.APIStatusError):
        kind: ModelErrorKind = "server" if exc.status_code >= 500 else "bad_request"
        return ModelError(kind, str(exc), status=exc.status_code)
    if isinstance(exc, openai.APIConnectionError):  # includes APITimeoutError
        return ModelError("connection", str(exc))
    if isinstance(exc, openai.APIError):
        # Raised mid-stream when an SSE payload carries an `error` object.
        body = exc.body if isinstance(exc.body, dict) else {}
        return ModelError(_code_kind(body.get("code") or body.get("type")), str(exc))
    return exc


class StreamParser:
    """Accumulates raw Responses API stream events into normalized deltas."""

    def __init__(self, model: str) -> None:
        self.model = model
        self.items: dict[int, dict[str, Any]] = {}
        self.done: set[int] = set()
        self.arguments: dict[int, list[str]] = {}
        self.texts: dict[int, dict[int, str]] = {}
        self.summaries: dict[int, dict[int, str]] = {}
        self.commands: dict[int, dict[int, str]] = {}
        self.refused = False
        self.status: str | None = None
        self.incomplete_reason: str | None = None
        self.usage = Usage()

    def feed(self, event: dict[str, Any]) -> Iterable[ModelDelta]:
        etype = event.get("type")
        index = event.get("output_index", -1)
        if etype in ("response.created", "response.in_progress"):
            self.model = (event.get("response") or {}).get("model") or self.model
        elif etype == "response.output_item.added":
            item = dict(event["item"])
            self.items[index] = item
            if item.get("type") == "function_call":
                self.arguments[index] = []
                yield ToolCallDelta(id=item["call_id"], name=item["name"])
            elif item.get("type") == "shell_call":
                yield ToolCallDelta(id=item["call_id"], name="shell")
        elif etype == "response.output_item.done":
            self.items[index] = dict(event["item"])
            self.done.add(index)
        elif etype == "response.output_text.delta":
            parts = self.texts.setdefault(index, {})
            cidx = event.get("content_index", 0)
            parts[cidx] = parts.get(cidx, "") + event["delta"]
            yield TextDelta(text=event["delta"])
        elif etype == "response.refusal.delta":
            self.refused = True
            yield TextDelta(text=event["delta"])
        elif etype == "response.function_call_arguments.delta":
            self.arguments.setdefault(index, []).append(event["delta"])
        elif etype == "response.reasoning_summary_part.added":
            if event.get("summary_index", 0) > 0:
                yield ThinkingDelta(text="\n\n")
        elif etype in ("response.reasoning_summary_text.delta", "response.reasoning_text.delta"):
            parts = self.summaries.setdefault(index, {})
            sidx = event.get("summary_index", event.get("content_index", 0))
            parts[sidx] = parts.get(sidx, "") + event["delta"]
            yield ThinkingDelta(text=event["delta"])
        elif etype == "response.shell_call_command.delta":
            cmds = self.commands.setdefault(index, {})
            cidx = event["command_index"]
            cmds[cidx] = cmds.get(cidx, "") + event["delta"]
        elif etype in ("response.shell_call_command.added", "response.shell_call_command.done"):
            self.commands.setdefault(index, {})[event["command_index"]] = event.get("command", "")
        elif etype in ("response.completed", "response.incomplete"):
            self._final(event.get("response") or {})
        elif etype == "response.failed":
            response = event.get("response") or {}
            err = response.get("error") or {}
            raise ModelError(_code_kind(err.get("code")), err.get("message") or "response failed")
        elif etype == "error":
            raise ModelError(_code_kind(event.get("code")), event.get("message") or "stream error")
        return

    def _final(self, response: dict[str, Any]) -> None:
        self.model = response.get("model") or self.model
        self.status = response.get("status") or self.status
        self.incomplete_reason = (response.get("incomplete_details") or {}).get("reason")
        for i, item in enumerate(response.get("output") or []):
            if i not in self.done:
                self.items[i] = dict(item)
                self.done.add(i)
        usage = response.get("usage") or {}
        cached = (usage.get("input_tokens_details") or {}).get("cached_tokens") or 0
        written = (usage.get("input_tokens_details") or {}).get("cache_write_tokens") or 0
        # OpenAI's input_tokens include cached tokens; normalized usage counts
        # them separately (as Anthropic reports them).
        self.usage = Usage(
            input_tokens=max((usage.get("input_tokens") or 0) - cached - written, 0),
            output_tokens=usage.get("output_tokens") or 0,
            cache_read_tokens=cached,
            cache_write_tokens=written,
        )

    def finish(self) -> ModelResponse:
        content: list[Any] = []
        for index in sorted(self.items):
            item = _clean(self.items[index])
            itype = item.get("type")
            if itype == "message":
                content.extend(self._message(index, item))
            elif itype == "reasoning":
                summary = [s.get("text", "") for s in item.get("summary") or []]
                if not any(summary):
                    summary = [t for _, t in sorted(self.summaries.get(index, {}).items())]
                content.append(
                    ThinkingBlock(text="\n\n".join(summary), vendor="openai", model=self.model, raw=item)
                )
            elif itype == "function_call":
                content.append(self._function_call(index, item))
            elif itype == "shell_call":
                content.append(self._shell_call(index, item))
            else:
                content.append(VendorBlock(vendor="openai", model=self.model, raw=item))

        has_calls = any(isinstance(b, ToolCallBlock) for b in content)
        stop: ModelStopReason
        if self.incomplete_reason == "max_output_tokens":
            stop = "max_tokens"
        elif self.incomplete_reason == "content_filter":
            stop = "refusal"
        elif has_calls:
            stop = "tool_use"
        elif self.refused:
            stop = "refusal"
        else:
            stop = "end_turn"
        return ModelResponse(
            message=Message(role="assistant", content=content),
            stop_reason=stop,
            usage=self.usage,
            model=self.model,
            refusal_category="content_filter" if self.incomplete_reason == "content_filter" else None,
        )

    def _message(self, index: int, item: dict[str, Any]) -> list[TextBlock]:
        blocks: list[TextBlock] = []
        meta = {"vendor": "openai", "raw": {"phase": item["phase"]}} if item.get("phase") else {}
        for part in item.get("content") or []:
            if part.get("type") == "output_text":
                blocks.append(TextBlock(text=part.get("text", ""), **meta))
            elif part.get("type") == "refusal":
                self.refused = True
                blocks.append(TextBlock(text=part.get("refusal", "")))
        if not blocks and self.texts.get(index):
            blocks = [TextBlock(text=t, **meta) for _, t in sorted(self.texts[index].items())]
        return blocks

    def _function_call(self, index: int, item: dict[str, Any]) -> ToolCallBlock:
        streamed = "".join(self.arguments.get(index, []))
        raw_args = item.get("arguments") or streamed
        item["arguments"] = raw_args
        parse_error = None
        try:
            args = json.loads(raw_args) if raw_args else {}
        except json.JSONDecodeError as exc:
            args, parse_error = {}, f"INVALID_JSON: {exc.msg}"
        if not isinstance(args, dict):
            args, parse_error = {}, parse_error or "INVALID_JSON: arguments are not an object"
        return ToolCallBlock(
            id=item["call_id"],
            name=item["name"],
            native_name=item["name"],
            arguments=args,
            vendor="openai",
            raw=item,
            parse_error=parse_error,
        )

    def _shell_call(self, index: int, item: dict[str, Any]) -> ToolCallBlock:
        action = item.get("action") or {}
        commands = list(action.get("commands") or [])
        if not commands and self.commands.get(index):
            commands = [c for _, c in sorted(self.commands[index].items())]
            item["action"] = {**action, "commands": commands}
        args: dict[str, Any] = {"command": "\n".join(commands)}
        if action.get("timeout_ms") is not None:
            args["timeout"] = action["timeout_ms"] / 1000
        return ToolCallBlock(
            id=item["call_id"],
            name="shell",
            native_name=SHELL_CALL,
            arguments=args,
            vendor="openai",
            raw=item,
        )
