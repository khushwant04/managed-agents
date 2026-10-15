"""Contract tests for the Anthropic adapter on recorded stream events.

Fixtures under ``fixtures/anthropic`` are raw Messages API stream events in
the SDK's ``to_dict()`` shape. They are hand-written from the documented
event format; refresh them from live traffic with ``scripts/record_fixtures.py``.
"""

from __future__ import annotations

from pathlib import Path

import anthropic
import httpx2 as httpx
import pytest

from runhive.adapters.anthropic import AnthropicAdapter
from runhive.adapters.base import ModelError
from runhive.testing import FakeAnthropicClient, load_fixture
from runhive.tools.builtins import builtin
from runhive.types import (
    Message,
    ModelRequest,
    ModelResponse,
    TextBlock,
    TextDelta,
    ThinkingBlock,
    ThinkingDelta,
    ToolCallBlock,
    ToolCallDelta,
    ToolResultBlock,
    ToolSpec,
    VendorBlock,
)

FIX = Path(__file__).parent / "fixtures" / "anthropic"


def fixture(name: str):
    return load_fixture(FIX / f"{name}.json")


def req(**kw) -> ModelRequest:
    return ModelRequest(model=kw.pop("model", "claude-opus-5-5"), messages=kw.pop("messages", [Message.user("hi")]), **kw)


async def collect(adapter: AnthropicAdapter, request: ModelRequest):
    deltas = [d async for d in adapter.stream(request)]
    final = deltas[-1]
    assert isinstance(final, ModelResponse)
    return deltas[:-1], final


def test_build_params_defaults_for_opus_5_5():
    a = AnthropicAdapter(client=object())
    p = a.build_params(req(system="Be brief.", reasoning="high"))
    assert p["model"] == "claude-opus-5-5"
    assert p["system"] == [{"type": "text", "text": "Be brief."}]
    assert p["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert p["output_config"] == {"effort": "high"}
    assert p["cache_control"] == {"type": "ephemeral"}
    assert p["fallbacks"] == "default" and p["betas"] == ["server-side-fallback-2026-07-01"]
    assert "tool_choice" not in p  # forced tool choice is never sent
    assert p["max_tokens"] == 64000


def test_build_params_options():
    a = AnthropicAdapter(client=object())
    p = a.build_params(
        req(
            model="claude-sonnet-4-6",
            options={"cache": "1h", "server_fallbacks": False, "compaction": True, "effort": "xhigh", "inference_geo": "us"},
        )
    )
    assert p["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    assert "fallbacks" not in p
    assert p["betas"] == ["compact-2026-01-12"]
    assert p["context_management"] == {"edits": [{"type": "compact_20260112"}]}
    assert p["output_config"] == {"effort": "xhigh"}
    assert p["inference_geo"] == "us"  # unknown options pass through
    off = a.build_params(req(options={"cache": "off"}))
    assert "cache_control" not in off


def test_legacy_models_use_budget_tokens():
    p = AnthropicAdapter(client=object()).build_params(req(model="claude-haiku-4-5", reasoning="medium"))
    assert p["thinking"] == {"type": "enabled", "budget_tokens": 8192}
    assert p["max_tokens"] == 64000 and "output_config" not in p


def test_tools_map_to_native_schemas():
    a = AnthropicAdapter(client=object())
    fn = ToolSpec(name="lookup", description="d", input_schema={"type": "object", "properties": {}})
    tools = [builtin("shell"), builtin("files"), builtin("code"), builtin("web_search", allowed_domains=["example.com"]), builtin("web_fetch"), fn]
    p = a.build_params(req(tools=tools))
    assert p["tools"][0] == {"type": "bash_20250124", "name": "bash"}
    assert p["tools"][1] == {"type": "text_editor_20250728", "name": "str_replace_based_edit_tool"}
    assert p["tools"][2]["name"] == "code" and p["tools"][2]["eager_input_streaming"] is True
    assert p["tools"][3] == {"type": "web_search_20260209", "name": "web_search", "allowed_domains": ["example.com"]}
    assert p["tools"][4] == {"type": "web_fetch_20260209", "name": "web_fetch"}
    assert p["tools"][5] == {"name": "lookup", "description": "d", "input_schema": fn.input_schema, "eager_input_streaming": True}
    basic = a.build_params(req(model="claude-haiku-5-5", tools=[builtin("web_search")]))
    assert basic["tools"][0]["type"] == "web_search_20250305"


def test_messages_translation_and_cross_vendor_rules():
    a = AnthropicAdapter(client=object())
    history = [
        Message.user("list pods"),
        Message(
            role="assistant",
            content=[
                ThinkingBlock(text="t", vendor="anthropic", model="claude-opus-4-8", raw={"type": "thinking", "thinking": "t", "signature": "s"}),
                ThinkingBlock(text="r", vendor="openai", model="gpt-6-astra", raw={"type": "reasoning"}),
                VendorBlock(vendor="openai", model="gpt-6-astra", raw={"type": "web_search_call"}),
                TextBlock(text="On it."),
                ToolCallBlock(id="call_1", name="shell", arguments={"command": "kubectl get pods"}, vendor="openai", native_name="shell"),
                ToolCallBlock(id="toolu_2", name="files", arguments={"command": "view", "path": "/workspace"}, vendor="anthropic", native_name="str_replace_based_edit_tool", raw={"input": {"command": "view", "path": "/workspace"}}),
            ],
        ),
        Message(role="user", content=[ToolResultBlock(call_id="call_1", content="pod-a"), ToolResultBlock(call_id="toolu_2", content="dir", is_error=True)]),
        Message.user("and now?"),
    ]
    msgs = a.build_params(req(messages=history))["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user"]  # consecutive user turns merged
    assistant = msgs[1]["content"]
    # Claude thinking from another Claude model is kept; other vendors' blocks are dropped.
    assert assistant[0] == {"type": "thinking", "thinking": "t", "signature": "s"}
    assert [b["type"] for b in assistant] == ["thinking", "text", "tool_use", "tool_use"]
    assert assistant[2] == {"type": "tool_use", "id": "call_1", "name": "bash", "input": {"command": "kubectl get pods"}}
    assert assistant[3]["name"] == "str_replace_based_edit_tool"
    assert msgs[2]["content"][0] == {"type": "tool_result", "tool_use_id": "call_1", "content": "pod-a", "is_error": False}
    assert msgs[2]["content"][2] == {"type": "text", "text": "and now?"}


async def test_stream_text_and_thinking():
    client = FakeAnthropicClient([fixture("text_turn")])
    deltas, final = await collect(AnthropicAdapter(client=client), req())
    assert [type(d) for d in deltas] == [ThinkingDelta, ThinkingDelta, TextDelta, TextDelta]
    assert final.message.text == "Hello, world."
    thinking = final.message.content[0]
    assert isinstance(thinking, ThinkingBlock)
    assert thinking.raw == {"type": "thinking", "thinking": "The user wants a greeting.", "signature": "EqQBCkYIBxgCKkA="}
    assert final.stop_reason == "end_turn"
    assert final.usage.input_tokens == 1200 and final.usage.output_tokens == 42 and final.usage.cache_read_tokens == 1000
    assert client.calls[0]["stream"] is True


async def test_stream_tool_calls_map_to_canonical_names():
    client = FakeAnthropicClient([fixture("tool_turn")])
    deltas, final = await collect(AnthropicAdapter(client=client), req())
    assert [d.name for d in deltas if isinstance(d, ToolCallDelta)] == ["shell", "lookup_deploys"]
    bash, lookup = final.message.tool_calls
    assert bash.name == "shell" and bash.native_name == "bash" and bash.arguments == {"command": "kubectl get pods"}
    assert lookup.arguments == {"service": "api", "minutes": 30}
    assert final.stop_reason == "tool_use"


async def test_truncated_tool_input_sets_parse_error():
    _, final = await collect(AnthropicAdapter(client=FakeAnthropicClient([fixture("bad_json")])), req())
    call = final.message.tool_calls[0]
    assert call.name == "files" and call.arguments == {} and call.parse_error.startswith("INVALID_JSON")
    assert final.stop_reason == "max_tokens"


async def test_server_tool_blocks_are_kept_as_vendor_blocks():
    _, final = await collect(AnthropicAdapter(client=FakeAnthropicClient([fixture("web_search")])), req())
    kinds = [b.raw["type"] if isinstance(b, VendorBlock) else b.type for b in final.message.content]
    assert kinds == ["server_tool_use", "web_search_tool_result", "text"]
    assert final.message.content[0].raw["input"] == {"query": "service-api outage"}
    assert final.message.tool_calls == []  # nothing for the runtime to execute


async def test_refusal_carries_category():
    _, final = await collect(AnthropicAdapter(client=FakeAnthropicClient([fixture("refusal")])), req())
    assert final.stop_reason == "refusal" and final.refusal_category == "cyber"


async def test_mid_output_fallback_drops_partial_blocks_before_marker():
    _, final = await collect(AnthropicAdapter(client=FakeAnthropicClient([fixture("fallback")])), req())
    assert final.model == "claude-opus-4-8"
    assert [b.type for b in final.message.content] == ["text", "text"]
    assert final.message.text == "Partial answer continued."
    assert final.message.tool_calls == []


def _status_error(cls, status: int):
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls("boom", response=httpx.Response(status, request=request), body=None)


@pytest.mark.parametrize(
    ("exc", "kind", "falls_back"),
    [
        (lambda: _status_error(anthropic.RateLimitError, 429), "rate_limit", True),
        (lambda: _status_error(anthropic.InternalServerError, 529), "server", True),
        (lambda: _status_error(anthropic.BadRequestError, 400), "bad_request", False),
        (lambda: _status_error(anthropic.AuthenticationError, 401), "auth", False),
        (lambda: anthropic.APIConnectionError(request=httpx.Request("POST", "https://x")), "connection", True),
    ],
)
async def test_errors_are_classified(exc, kind, falls_back):
    adapter = AnthropicAdapter(client=FakeAnthropicClient([exc()]))
    with pytest.raises(ModelError) as info:
        await collect(adapter, req())
    assert info.value.kind == kind and info.value.should_fall_back is falls_back


async def test_stream_error_event_raises():
    events = [{"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}]
    with pytest.raises(ModelError) as info:
        await collect(AnthropicAdapter(client=FakeAnthropicClient([events])), req())
    assert info.value.kind == "server"


def test_capabilities():
    a = AnthropicAdapter(client=object())
    m = a.capabilities("claude-opus-5-5")
    assert m.reasoning and m.prompt_caching and m.server_web_search and m.native_compaction
    assert m.context_window == 1_000_000 and m.max_output_tokens == 128_000
    assert "code_execution" in m.non_zdr_features
    assert a.capabilities("claude-haiku-4-5").context_window == 200_000
    assert "model_requires_retention" in a.capabilities("claude-fable-5-1").non_zdr_features
