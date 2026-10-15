"""Contract tests for the OpenAI Responses adapter on recorded stream events."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Required, get_origin, get_type_hints

import httpx2
import openai
import pydantic
import pytest
from openai.types.responses import (
    EasyInputMessageParam,
    FunctionShellToolParam,
    FunctionToolParam,
    ResponseFunctionToolCallParam,
    ResponseReasoningItemParam,
    ResponseStreamEvent,
    WebSearchToolParam,
)
from openai.types.responses.response_create_params import ResponseCreateParamsStreaming
from openai.types.responses.response_input_item_param import (
    FunctionCallOutput,
    ShellCall,
    ShellCallOutput,
)

from runhive.adapters.anthropic import AnthropicAdapter
from runhive.adapters.base import ModelError
from runhive.adapters.openai import SHELL_CALL, OpenAIAdapter
from runhive.tools.builtins import (
    CODE_SCHEMA,
    FILES_SCHEMA,
    SHELL_SCHEMA,
    WEB_FETCH_SCHEMA,
    builtin,
)
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

FIXTURES = Path(__file__).parent / "fixtures" / "openai"
MODEL = "gpt-5.5"
WEATHER = ToolSpec(
    name="get_weather",
    description="Current weather for a city.",
    input_schema={"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
)


def load(name: str) -> list[dict[str, Any]]:
    return json.loads((FIXTURES / f"{name}.json").read_text())


class FakeResponses:
    def __init__(self, events: list[Any] | None = None, error: Exception | None = None) -> None:
        self.events = events or []
        self.error = error
        self.calls: list[dict[str, Any]] = []

    async def create(self, **params: Any) -> Any:
        self.calls.append(params)
        if self.error is not None:
            raise self.error
        return self._iter()

    async def _iter(self) -> Any:
        for event in self.events:
            if isinstance(event, Exception):
                raise event
            yield event


class FakeClient:
    def __init__(self, events: list[Any] | None = None, error: Exception | None = None) -> None:
        self.responses = FakeResponses(events, error)


def request(**kwargs: Any) -> ModelRequest:
    kwargs.setdefault("model", MODEL)
    kwargs.setdefault("messages", [Message.user("hi")])
    return ModelRequest(**kwargs)


async def run(events: list[Any], **kwargs: Any) -> tuple[list[Any], ModelResponse, FakeClient]:
    client = FakeClient(events)
    deltas = [d async for d in OpenAIAdapter(client=client).stream(request(**kwargs))]
    final = deltas[-1]
    assert isinstance(final, ModelResponse)
    return deltas[:-1], final, client


def assert_shape(value: dict[str, Any], typed_dict: type) -> None:
    """Check a param dict's keys against an SDK TypedDict (top level)."""
    hints = get_type_hints(typed_dict, include_extras=True)
    required = {k for k, v in hints.items() if get_origin(v) is Required}
    assert set(value) <= set(hints), f"unknown keys {set(value) - set(hints)} for {typed_dict.__name__}"
    assert required <= set(value), f"missing {required - set(value)} for {typed_dict.__name__}"


_ITEM_SHAPES = {
    "message": EasyInputMessageParam,
    "function_call": ResponseFunctionToolCallParam,
    "function_call_output": FunctionCallOutput,
    "shell_call": ShellCall,
    "shell_call_output": ShellCallOutput,
    "reasoning": ResponseReasoningItemParam,
}
_TOOL_SHAPES = {"function": FunctionToolParam, "shell": FunctionShellToolParam, "web_search": WebSearchToolParam}


def assert_params_shape(params: dict[str, Any]) -> None:
    assert_shape({**params, "stream": True}, ResponseCreateParamsStreaming)
    for item in params["input"]:
        assert_shape(item, _ITEM_SHAPES[item["type"]])
    for tool in params.get("tools", []):
        assert_shape(tool, _TOOL_SHAPES[tool["type"]])


# -- fixtures are real SDK shapes ------------------------------------------


def _no_extra(model: Any) -> None:
    if isinstance(model, pydantic.BaseModel):
        assert not model.model_extra, (type(model).__name__, model.model_extra)
        for name in type(model).model_fields:
            _no_extra(getattr(model, name))
    elif isinstance(model, list):
        for value in model:
            _no_extra(value)


@pytest.mark.parametrize("path", sorted(FIXTURES.glob("*.json")), ids=lambda p: p.stem)
def test_fixtures_match_sdk_event_types(path: Path) -> None:
    adapter = pydantic.TypeAdapter(ResponseStreamEvent)
    for raw in json.loads(path.read_text()):
        event = adapter.validate_python(raw)
        _no_extra(event)
        assert event.to_dict() == raw


# -- request building --------------------------------------------------------


def test_build_params_basics() -> None:
    params = OpenAIAdapter().build_params(
        request(model="gpt-4o", system="Be terse.", messages=[Message.user("hi")], max_tokens=64000)
    )
    assert params["model"] == "gpt-4o"
    assert params["instructions"] == "Be terse."
    assert params["store"] is False
    assert "previous_response_id" not in params
    assert params["max_output_tokens"] == 16_384  # clamped to the model's limit
    assert params["input"] == [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}]
    assert "reasoning" not in params and "include" not in params
    assert_params_shape(params)


def test_tools_native_shell_and_builtins() -> None:
    tools = [
        WEATHER,
        builtin("shell"),
        builtin("files"),
        builtin("code"),
        builtin("web_search", allowed_domains=["example.com"], search_context_size="low"),
        builtin("web_fetch"),
    ]
    params = OpenAIAdapter().build_params(request(tools=tools))
    by_name = {t.get("name", t["type"]): t for t in params["tools"]}
    assert by_name["get_weather"] == {
        "type": "function",
        "name": "get_weather",
        "description": "Current weather for a city.",
        "parameters": WEATHER.input_schema,
        "strict": False,
    }
    assert by_name["shell"] == {"type": "shell", "environment": {"type": "local"}}
    assert by_name["files"]["parameters"] == FILES_SCHEMA
    assert by_name["code"]["parameters"] == CODE_SCHEMA
    assert by_name["web_fetch"]["type"] == "function"
    assert by_name["web_fetch"]["parameters"] == WEB_FETCH_SCHEMA
    assert by_name["web_search"] == {
        "type": "web_search",
        "filters": {"allowed_domains": ["example.com"]},
        "search_context_size": "low",
    }
    assert_params_shape(params)


def test_shell_falls_back_to_function_tool() -> None:
    adapter = OpenAIAdapter()
    for req in (
        request(model="gpt-4.1", tools=[builtin("shell")]),
        request(tools=[builtin("shell")], options={"native_shell": False}),
    ):
        (tool,) = adapter.build_params(req)["tools"]
        assert tool["type"] == "function" and tool["name"] == "shell"
        assert tool["parameters"] == SHELL_SCHEMA
    forced = adapter.build_params(request(model="gpt-4.1", tools=[builtin("shell")], options={"native_shell": True}))
    assert forced["tools"] == [{"type": "shell", "environment": {"type": "local"}}]


def test_web_search_with_block_list_uses_runtime_tool() -> None:
    params = OpenAIAdapter().build_params(request(tools=[builtin("web_search", blocked_domains=["x.com"])]))
    (tool,) = params["tools"]
    assert tool["type"] == "function" and tool["name"] == "web_search"


def test_reasoning_effort_and_encrypted_content() -> None:
    params = OpenAIAdapter().build_params(request(reasoning="high"))
    assert params["reasoning"] == {"effort": "high", "summary": "auto"}
    assert params["include"] == ["reasoning.encrypted_content"]
    default = OpenAIAdapter().build_params(request())
    assert default["reasoning"] == {"summary": "auto"}
    plain = OpenAIAdapter().build_params(request(model="gpt-4.1", reasoning="high"))
    assert "reasoning" not in plain and "include" not in plain


def test_options_passthrough_consumed_and_rejected() -> None:
    adapter = OpenAIAdapter()
    params = adapter.build_params(
        request(
            reasoning="low",
            options={
                "prompt_cache_key": "agent-42",
                "effort": "xhigh",
                "include": ["web_search_call.action.sources"],
                "compaction": 200_000,
            },
        )
    )
    assert params["prompt_cache_key"] == "agent-42"
    assert params["reasoning"]["effort"] == "xhigh"
    assert "effort" not in params and "compaction" not in params
    assert params["include"] == ["web_search_call.action.sources", "reasoning.encrypted_content"]
    assert params["context_management"] == [{"type": "compaction", "compact_threshold": 200_000}]
    assert_params_shape(params)
    for key in ("background", "previous_response_id", "store"):
        with pytest.raises(ModelError) as info:
            adapter.build_params(request(options={key: True}))
        assert info.value.kind == "bad_request"


def _claude_turn() -> list[Message]:
    return [
        Message.user("list files"),
        Message(
            role="assistant",
            content=[
                ThinkingBlock(text="hmm", vendor="anthropic", model="claude-opus-5", raw={"type": "thinking"}),
                TextBlock(text="Listing."),
                ToolCallBlock(
                    id="toolu_1",
                    name="shell",
                    native_name="bash",
                    vendor="anthropic",
                    arguments={"command": "ls", "timeout": 5},
                    raw={"input": {"command": "ls"}},
                ),
                ToolCallBlock(id="toolu_2", name="get_weather", vendor="anthropic", arguments={"city": "Rome"}),
                VendorBlock(vendor="anthropic", model="claude-opus-5", raw={"type": "server_tool_use"}),
            ],
        ),
        Message(
            role="user",
            content=[
                ToolResultBlock(call_id="toolu_1", content="a.txt\n", native_name="bash"),
                ToolResultBlock(call_id="toolu_2", content="sunny", is_error=False),
                TextBlock(text="thanks"),
            ],
        ),
    ]


def test_cross_vendor_transcript_with_native_shell() -> None:
    params = OpenAIAdapter().build_params(request(messages=_claude_turn(), tools=[builtin("shell"), WEATHER]))
    assert params["input"] == [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "list files"}]},
        {"type": "message", "role": "assistant", "content": "Listing."},
        {
            "type": "shell_call",
            "call_id": "toolu_1",
            "action": {"commands": ["ls"], "timeout_ms": 5000},
            "status": "completed",
        },
        {"type": "function_call", "call_id": "toolu_2", "name": "get_weather", "arguments": '{"city": "Rome"}'},
        {
            "type": "shell_call_output",
            "call_id": "toolu_1",
            "output": [{"stdout": "a.txt\n", "stderr": "", "outcome": {"type": "exit", "exit_code": 0}}],
        },
        {"type": "function_call_output", "call_id": "toolu_2", "output": "sunny"},
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "thanks"}]},
    ]
    assert_params_shape(params)


def test_cross_vendor_transcript_with_function_shell() -> None:
    params = OpenAIAdapter().build_params(
        request(model="gpt-4.1", messages=_claude_turn(), tools=[builtin("shell"), WEATHER])
    )
    calls = [i for i in params["input"] if i["type"].startswith(("function_call", "shell_call"))]
    assert calls[0] == {
        "type": "function_call",
        "call_id": "toolu_1",
        "name": "shell",
        "arguments": '{"command": "ls", "timeout": 5}',
    }
    assert calls[2] == {"type": "function_call_output", "call_id": "toolu_1", "output": "a.txt\n"}
    assert_params_shape(params)


# -- streaming ---------------------------------------------------------------


async def test_text_and_reasoning_stream() -> None:
    deltas, final, client = await run(load("text_reasoning"), reasoning="medium")
    assert [d.text for d in deltas if isinstance(d, ThinkingDelta)] == [
        "**Checking the question**\n\n",
        "User wants a greeting.",
        "\n\n",
        "Reply briefly.",
    ]
    assert [d.text for d in deltas if isinstance(d, TextDelta)] == ["Hello", " there!"]
    thinking, text = final.message.content
    assert isinstance(thinking, ThinkingBlock)
    assert thinking.vendor == "openai"
    assert thinking.text == "**Checking the question**\n\nUser wants a greeting.\n\nReply briefly."
    assert thinking.raw["encrypted_content"] == "gAAAAABo-enc-reasoning-01"
    assert text == TextBlock(text="Hello there!", vendor="openai", raw={"phase": "final_answer"})
    assert final.stop_reason == "end_turn"
    assert final.model == "gpt-5.5-2026-04-23"
    assert final.usage.input_tokens == 1200 - 1024
    assert final.usage.cache_read_tokens == 1024
    assert final.usage.output_tokens == 85
    assert client.responses.calls[0]["store"] is False


async def test_reasoning_round_trips_only_to_openai() -> None:
    _, final, _ = await run(load("text_reasoning"))
    transcript = [Message.user("hi"), final.message, Message.user("again")]
    items = OpenAIAdapter().build_params(request(messages=transcript))["input"]
    reasoning = items[1]
    assert reasoning["type"] == "reasoning" and reasoning["encrypted_content"] == "gAAAAABo-enc-reasoning-01"
    assert items[2] == {"type": "message", "role": "assistant", "content": "Hello there!", "phase": "final_answer"}
    assert_shape(reasoning, ResponseReasoningItemParam)
    # Without encrypted content the item can't be replayed statelessly.
    stripped = ThinkingBlock(text="x", vendor="openai", model=MODEL, raw={"type": "reasoning", "id": "rs_9", "summary": []})
    items = OpenAIAdapter().build_params(request(messages=[Message(role="assistant", content=[stripped])]))["input"]
    assert items == []
    # Claude never sees OpenAI reasoning.
    claude = AnthropicAdapter().build_params(request(model="claude-opus-5", messages=transcript))
    assert all(b["type"] == "text" for m in claude["messages"] for b in m["content"])


async def test_tool_call_stream_with_native_shell() -> None:
    deltas, final, _ = await run(load("tool_calls"), tools=[WEATHER, builtin("shell")])
    assert [d for d in deltas if isinstance(d, ToolCallDelta)] == [
        ToolCallDelta(id="call_weather", name="get_weather"),
        ToolCallDelta(id="call_shell", name="shell"),
    ]
    weather, shell = final.message.content
    assert isinstance(weather, ToolCallBlock) and isinstance(shell, ToolCallBlock)
    assert weather.name == "get_weather" and weather.arguments == {"city": "Paris", "unit": "c"}
    assert weather.parse_error is None and weather.vendor == "openai"
    assert shell.name == "shell" and shell.native_name == SHELL_CALL
    assert shell.arguments == {"command": "ls -la /workspace\ncat README.md", "timeout": 30.0}
    assert shell.raw["type"] == "shell_call"
    assert final.stop_reason == "tool_use"
    assert final.usage.input_tokens == 900 and final.usage.output_tokens == 60

    # Next turn: native items are echoed, results go back in the native shape.
    transcript = [
        Message.user("go"),
        final.message,
        Message(
            role="user",
            content=[
                ToolResultBlock(call_id="call_weather", content='{"temp": 18}'),
                ToolResultBlock(call_id="call_shell", content="boom", is_error=True, native_name=SHELL_CALL),
            ],
        ),
    ]
    params = OpenAIAdapter().build_params(request(messages=transcript, tools=[WEATHER, builtin("shell")]))
    items = params["input"]
    assert items[1] == {
        "type": "function_call",
        "id": "fc_01",
        "call_id": "call_weather",
        "name": "get_weather",
        "arguments": '{"city": "Paris", "unit": "c"}',
        "status": "completed",
    }
    assert items[2]["type"] == "shell_call" and items[2]["id"] == "sh_01"
    assert items[2]["action"]["commands"] == ["ls -la /workspace", "cat README.md"]
    assert items[3] == {"type": "function_call_output", "call_id": "call_weather", "output": '{"temp": 18}'}
    assert items[4] == {
        "type": "shell_call_output",
        "call_id": "call_shell",
        "output": [{"stdout": "boom", "stderr": "", "outcome": {"type": "exit", "exit_code": 1}}],
        "max_output_length": 4096,
    }
    assert_params_shape(params)

    # The same native call, presented to a model without the shell tool.
    params = OpenAIAdapter().build_params(request(model="gpt-4.1", messages=transcript, tools=[builtin("shell")]))
    assert params["input"][2] == {
        "type": "function_call",
        "call_id": "call_shell",
        "name": "shell",
        "arguments": json.dumps({"command": "ls -la /workspace\ncat README.md", "timeout": 30.0}),
    }
    assert params["input"][4]["type"] == "function_call_output"


async def test_invalid_json_arguments() -> None:
    deltas, final, _ = await run(load("invalid_arguments"), tools=[WEATHER])
    assert deltas == [ToolCallDelta(id="call_bad", name="get_weather")]
    (call,) = final.message.content
    assert isinstance(call, ToolCallBlock)
    assert call.arguments == {}
    assert call.parse_error is not None and call.parse_error.startswith("INVALID_JSON")
    assert final.stop_reason == "tool_use"


async def test_arguments_and_text_from_deltas_when_items_lack_them() -> None:
    events = [
        {"type": "response.output_item.added", "output_index": 0, "sequence_number": 0,
         "item": {"type": "function_call", "id": "fc_1", "call_id": "c1", "name": "get_weather", "arguments": ""}},
        {"type": "response.function_call_arguments.delta", "output_index": 0, "item_id": "fc_1",
         "sequence_number": 1, "delta": '{"city": '},
        {"type": "response.function_call_arguments.delta", "output_index": 0, "item_id": "fc_1",
         "sequence_number": 2, "delta": '"Oslo"}'},
        {"type": "response.output_item.added", "output_index": 1, "sequence_number": 3,
         "item": {"type": "message", "id": "m1", "role": "assistant", "status": "in_progress", "content": []}},
        {"type": "response.output_text.delta", "output_index": 1, "item_id": "m1", "content_index": 0,
         "sequence_number": 4, "delta": "ok", "logprobs": []},
        {"type": "response.completed", "sequence_number": 5,
         "response": {"id": "r", "model": MODEL, "status": "completed", "output": []}},
    ]  # fmt: skip
    _, final, _ = await run(events)
    call, text = final.message.content
    assert isinstance(call, ToolCallBlock) and call.arguments == {"city": "Oslo"}
    assert text == TextBlock(text="ok")


async def test_incomplete_max_output_tokens() -> None:
    deltas, final, _ = await run(load("incomplete"))
    assert deltas == [TextDelta(text="The first three")]
    assert final.message.content == [TextBlock(text="The first three", vendor="openai", raw={"phase": "final_answer"})]
    assert final.stop_reason == "max_tokens"


async def test_refusal() -> None:
    deltas, final, _ = await run(load("refusal"))
    assert deltas == [TextDelta(text="I can't help with that.")]
    assert final.message.content == [TextBlock(text="I can't help with that.")]
    assert final.stop_reason == "refusal"


async def test_response_failed_raises() -> None:
    with pytest.raises(ModelError) as info:
        await run(load("failed"))
    assert info.value.kind == "server" and info.value.should_fall_back


async def test_error_event_raises() -> None:
    with pytest.raises(ModelError) as info:
        await run(load("error_event"))
    assert info.value.kind == "rate_limit"


# -- error classification ----------------------------------------------------

_REQ = httpx2.Request("POST", "https://api.openai.com/v1/responses")


def _status(cls: type[openai.APIStatusError], code: int) -> openai.APIStatusError:
    body = {"message": "nope", "type": "error", "code": None}
    return cls(f"Error code: {code}", response=httpx2.Response(code, request=_REQ), body=body)


@pytest.mark.parametrize(
    ("error", "kind", "status"),
    [
        (_status(openai.RateLimitError, 429), "rate_limit", 429),
        (_status(openai.InternalServerError, 500), "server", 500),
        (_status(openai.APIStatusError, 503), "server", 503),
        (_status(openai.BadRequestError, 400), "bad_request", 400),
        (_status(openai.NotFoundError, 404), "bad_request", 404),
        (_status(openai.AuthenticationError, 401), "auth", 401),
        (_status(openai.PermissionDeniedError, 403), "auth", 403),
        (openai.APIConnectionError(request=_REQ), "connection", None),
        (openai.APITimeoutError(request=_REQ), "connection", None),
    ],
)
async def test_error_classification(error: Exception, kind: str, status: int | None) -> None:
    client = FakeClient(error=error)
    with pytest.raises(ModelError) as info:
        [d async for d in OpenAIAdapter(client=client).stream(request())]
    assert info.value.kind == kind
    assert info.value.status == status
    assert info.value.__cause__ is error


async def test_mid_stream_api_error() -> None:
    error = openai.APIError("overloaded", _REQ, body={"type": "server_error", "code": "server_error"})
    with pytest.raises(ModelError) as info:
        await run([load("text_reasoning")[0], error])
    assert info.value.kind == "server"


async def test_unknown_errors_propagate() -> None:
    with pytest.raises(ValueError):
        [d async for d in OpenAIAdapter(client=FakeClient(error=ValueError("bug"))).stream(request())]


# -- capabilities ------------------------------------------------------------


def test_capabilities() -> None:
    adapter = OpenAIAdapter()
    gpt5 = adapter.capabilities("gpt-5.5")
    assert gpt5.vendor == "openai"
    assert gpt5.reasoning and gpt5.thinking_visible and gpt5.prompt_caching
    assert gpt5.server_web_search and not gpt5.server_web_fetch
    assert gpt5.native_compaction
    assert gpt5.context_window and gpt5.max_output_tokens
    o3 = adapter.capabilities("o3")
    assert o3.reasoning and not o3.native_compaction
    gpt41 = adapter.capabilities("gpt-4.1")
    assert not gpt41.reasoning and gpt41.prompt_caching
    unknown = adapter.capabilities("some-future-model")
    assert unknown.tools and unknown.streaming
    assert not (unknown.reasoning or unknown.prompt_caching or unknown.server_web_search)
    assert unknown.missing({"reasoning", "tools"}) == {"reasoning"}


async def test_assistant_phase_round_trips() -> None:
    events = [
        {"type": "response.output_item.done", "output_index": 0, "sequence_number": 1, "item": {
            "id": "msg_1", "type": "message", "role": "assistant", "status": "completed", "phase": "final_answer",
            "content": [{"type": "output_text", "text": "Done.", "annotations": []}],
        }},
    ]
    _, final, _ = await run(events)
    block = final.message.content[0]
    assert block.text == "Done." and block.vendor == "openai" and block.raw == {"phase": "final_answer"}
    params = OpenAIAdapter(client=FakeClient()).build_params(
        request(messages=[Message.user("hi"), final.message, Message.user("thanks")])
    )
    assert_params_shape(params)
    assert params["input"][1] == {"type": "message", "role": "assistant", "content": "Done.", "phase": "final_answer"}
