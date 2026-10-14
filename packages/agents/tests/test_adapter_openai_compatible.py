"""Contract tests for the OpenAI-compatible Chat Completions adapter on recorded chunks."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Required, get_origin, get_type_hints

import httpx2
import openai
import pydantic
import pytest
from agents.adapters.base import ModelError
from agents.adapters.openai_compatible import OpenAICompatibleAdapter
from agents.tools.builtins import (
    CODE_SCHEMA,
    FILES_SCHEMA,
    SHELL_SCHEMA,
    WEB_SEARCH_SCHEMA,
    builtin,
)
from agents.types import (
    Message,
    ModelRequest,
    ModelResponse,
    TextBlock,
    TextDelta,
    ThinkingBlock,
    ToolCallBlock,
    ToolCallDelta,
    ToolResultBlock,
    ToolSpec,
    VendorBlock,
)
from openai.types.chat import (
    ChatCompletionAssistantMessageParam,
    ChatCompletionChunk,
    ChatCompletionFunctionToolParam,
    ChatCompletionSystemMessageParam,
    ChatCompletionToolMessageParam,
    ChatCompletionUserMessageParam,
)
from openai.types.chat.completion_create_params import CompletionCreateParamsStreaming

FIXTURES = Path(__file__).parent / "fixtures" / "openai_compatible"
MODEL = "qwen3-coder:30b"
WEATHER = ToolSpec(
    name="get_weather",
    description="Current weather for a city.",
    input_schema={"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
)


def load(name: str) -> list[dict[str, Any]]:
    return json.loads((FIXTURES / f"{name}.json").read_text())


class FakeCompletions:
    def __init__(self, chunks: list[Any] | None = None, error: Exception | None = None) -> None:
        self.chunks = chunks or []
        self.error = error
        self.calls: list[dict[str, Any]] = []

    async def create(self, **params: Any) -> Any:
        self.calls.append(params)
        if self.error is not None:
            raise self.error
        return self._iter()

    async def _iter(self) -> Any:
        for chunk in self.chunks:
            if isinstance(chunk, Exception):
                raise chunk
            yield chunk


class FakeChat:
    def __init__(self, completions: FakeCompletions) -> None:
        self.completions = completions


class FakeClient:
    def __init__(self, chunks: list[Any] | None = None, error: Exception | None = None) -> None:
        self.chat = FakeChat(FakeCompletions(chunks, error))


def request(**kwargs: Any) -> ModelRequest:
    kwargs.setdefault("model", MODEL)
    kwargs.setdefault("messages", [Message.user("hi")])
    return ModelRequest(**kwargs)


def adapter(client: Any = None) -> OpenAICompatibleAdapter:
    return OpenAICompatibleAdapter(base_url="http://localhost:11434/v1", client=client)


async def run(chunks: list[Any], **kwargs: Any) -> tuple[list[Any], ModelResponse, FakeClient]:
    client = FakeClient(chunks)
    deltas = [d async for d in adapter(client).stream(request(**kwargs))]
    final = deltas[-1]
    assert isinstance(final, ModelResponse)
    return deltas[:-1], final, client


def assert_shape(value: dict[str, Any], typed_dict: type) -> None:
    """Check a param dict's keys against an SDK TypedDict (top level)."""
    hints = get_type_hints(typed_dict, include_extras=True)
    required = {k for k, v in hints.items() if get_origin(v) is Required}
    assert set(value) <= set(hints), f"unknown keys {set(value) - set(hints)} for {typed_dict.__name__}"
    assert required <= set(value), f"missing {required - set(value)} for {typed_dict.__name__}"


_MESSAGE_SHAPES = {
    "system": ChatCompletionSystemMessageParam,
    "user": ChatCompletionUserMessageParam,
    "assistant": ChatCompletionAssistantMessageParam,
    "tool": ChatCompletionToolMessageParam,
}


def assert_params_shape(params: dict[str, Any]) -> None:
    assert_shape({**params, "stream": True}, CompletionCreateParamsStreaming)
    for message in params["messages"]:
        assert_shape(message, _MESSAGE_SHAPES[message["role"]])
    for tool in params.get("tools", []):
        assert_shape(tool, ChatCompletionFunctionToolParam)


def _no_extra(model: Any) -> None:
    if isinstance(model, pydantic.BaseModel):
        assert not model.model_extra, (type(model).__name__, model.model_extra)
        for name in type(model).model_fields:
            _no_extra(getattr(model, name))
    elif isinstance(model, list):
        for value in model:
            _no_extra(value)


@pytest.mark.parametrize("path", sorted(FIXTURES.glob("*.json")), ids=lambda p: p.stem)
def test_fixtures_match_sdk_chunk_type(path: Path) -> None:
    for raw in json.loads(path.read_text()):
        chunk = ChatCompletionChunk.model_validate(raw)
        _no_extra(chunk)
        assert chunk.to_dict() == raw


# -- request building --------------------------------------------------------


def test_build_params_tools_are_canonical_functions() -> None:
    tools = [WEATHER, builtin("shell"), builtin("files"), builtin("code"), builtin("web_search")]
    params = adapter().build_params(
        request(system="Be terse.", tools=tools, max_tokens=2048, options={"temperature": 0.2})
    )
    assert params["model"] == MODEL
    assert params["messages"][0] == {"role": "system", "content": "Be terse."}
    assert params["stream_options"] == {"include_usage": True}
    assert params["max_tokens"] == 2048
    assert params["temperature"] == 0.2
    schemas = {t["function"]["name"]: t["function"]["parameters"] for t in params["tools"]}
    assert all(t["type"] == "function" for t in params["tools"])
    assert schemas == {
        "get_weather": WEATHER.input_schema,
        "shell": SHELL_SCHEMA,
        "files": FILES_SCHEMA,
        "code": CODE_SCHEMA,
        "web_search": WEB_SEARCH_SCHEMA,
    }
    assert_params_shape(params)


def test_messages_from_mixed_vendor_transcript() -> None:
    transcript = [
        Message.user("list files"),
        Message(
            role="assistant",
            content=[
                ThinkingBlock(text="hmm", vendor="openai", model="gpt-5.5", raw={"type": "reasoning"}),
                TextBlock(text="Listing."),
                ToolCallBlock(
                    id="call_shell",
                    name="shell",
                    native_name="shell_call",
                    vendor="openai",
                    arguments={"command": "ls\ncat README.md"},
                    raw={"type": "shell_call", "action": {"commands": ["ls", "cat README.md"]}},
                ),
                ToolCallBlock(id="toolu_2", name="files", native_name="str_replace_based_edit_tool",
                              vendor="anthropic", arguments={"command": "view", "path": "/workspace"}),
                VendorBlock(vendor="openai", model="gpt-5.5", raw={"type": "web_search_call"}),
            ],
        ),
        Message(
            role="user",
            content=[
                TextBlock(text="also this"),
                ToolResultBlock(call_id="call_shell", content="README.md\n", native_name="shell_call"),
                ToolResultBlock(call_id="toolu_2", content="a.txt", is_error=True),
            ],
        ),
        Message(role="assistant", content=[ThinkingBlock(text="only thinking", vendor="anthropic", model="c")]),
    ]  # fmt: skip
    params = adapter().build_params(request(messages=transcript))
    assert params["messages"] == [
        {"role": "user", "content": "list files"},
        {
            "role": "assistant",
            "content": "Listing.",
            "tool_calls": [
                {
                    "id": "call_shell",
                    "type": "function",
                    "function": {"name": "shell", "arguments": '{"command": "ls\\ncat README.md"}'},
                },
                {
                    "id": "toolu_2",
                    "type": "function",
                    "function": {"name": "files", "arguments": '{"command": "view", "path": "/workspace"}'},
                },
            ],
        },
        {"role": "tool", "tool_call_id": "call_shell", "content": "README.md\n"},
        {"role": "tool", "tool_call_id": "toolu_2", "content": "a.txt"},
        {"role": "user", "content": "also this"},
    ]
    assert_params_shape(params)


# -- streaming ---------------------------------------------------------------


async def test_text_stream_and_usage() -> None:
    deltas, final, client = await run(load("text"))
    assert deltas == [TextDelta(text="Hello"), TextDelta(text=" world")]
    assert final.message.content == [TextBlock(text="Hello world")]
    assert final.stop_reason == "end_turn"
    assert final.model == MODEL
    assert final.usage.input_tokens == 120 - 64
    assert final.usage.cache_read_tokens == 64
    assert final.usage.output_tokens == 4
    assert client.chat.completions.calls[0]["stream_options"] == {"include_usage": True}


async def test_parallel_tool_calls_accumulate_by_index() -> None:
    deltas, final, _ = await run(load("tool_calls"), tools=[builtin("shell"), WEATHER])
    assert deltas == [ToolCallDelta(id="call_a", name="shell"), ToolCallDelta(id="call_b", name="get_weather")]
    shell, weather = final.message.content
    assert isinstance(shell, ToolCallBlock) and isinstance(weather, ToolCallBlock)
    assert shell.id == "call_a" and shell.name == "shell" and shell.arguments == {"command": "ls"}
    assert weather.id == "call_b" and weather.arguments == {"city": "Oslo"}
    assert shell.vendor == "openai-compatible" and shell.parse_error is None
    assert final.stop_reason == "tool_use"
    assert final.usage.input_tokens == 300 and final.usage.output_tokens == 40


async def test_invalid_json_arguments() -> None:
    _, final, _ = await run(load("invalid_arguments"))
    (call,) = final.message.content
    assert isinstance(call, ToolCallBlock)
    assert call.arguments == {}
    assert call.parse_error is not None and call.parse_error.startswith("INVALID_JSON")


async def test_length_is_max_tokens() -> None:
    _, final, _ = await run(load("length"))
    assert final.stop_reason == "max_tokens"
    assert final.message.text == "Once upon"


def _chunk(delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
    return {
        "id": "c",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": MODEL,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


async def test_content_filter_is_refusal() -> None:
    _, final, _ = await run([_chunk({"content": "I"}), _chunk({}, "content_filter")])
    assert final.stop_reason == "refusal"


async def test_tool_calls_with_stop_finish_reason() -> None:
    call = {"index": 0, "id": "x", "type": "function", "function": {"name": "get_weather", "arguments": "{}"}}
    _, final, _ = await run([_chunk({"tool_calls": [call]}), _chunk({}, "stop")])
    assert final.stop_reason == "tool_use"


# -- errors and capabilities -------------------------------------------------

_REQ = httpx2.Request("POST", "http://localhost:11434/v1/chat/completions")


@pytest.mark.parametrize(
    ("error", "kind"),
    [
        (openai.RateLimitError("429", response=httpx2.Response(429, request=_REQ), body=None), "rate_limit"),
        (openai.InternalServerError("502", response=httpx2.Response(502, request=_REQ), body=None), "server"),
        (openai.BadRequestError("400", response=httpx2.Response(400, request=_REQ), body=None), "bad_request"),
        (openai.AuthenticationError("401", response=httpx2.Response(401, request=_REQ), body=None), "auth"),
        (openai.APIConnectionError(request=_REQ), "connection"),
    ],
)
async def test_error_classification(error: Exception, kind: str) -> None:
    with pytest.raises(ModelError) as info:
        [d async for d in adapter(FakeClient(error=error)).stream(request())]
    assert info.value.kind == kind


async def test_mid_stream_error() -> None:
    error = openai.APIError("rate limited", _REQ, body={"code": "rate_limit_exceeded", "message": "slow"})
    with pytest.raises(ModelError) as info:
        await run([load("text")[0], error])
    assert info.value.kind == "rate_limit"


def test_capabilities_and_client() -> None:
    a = OpenAICompatibleAdapter(base_url="http://localhost:8000/v1", api_key="k")
    caps = a.capabilities(MODEL)
    assert caps.vendor == "openai-compatible" and caps.tools and caps.streaming
    assert caps.missing({"reasoning", "prompt_caching", "server_web_search"}) == {
        "reasoning",
        "prompt_caching",
        "server_web_search",
    }
    assert str(a.client.base_url).startswith("http://localhost:8000/v1")
    assert a.client.api_key == "k"
