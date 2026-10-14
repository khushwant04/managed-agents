"""Normalized types shared by the runtime and every model adapter.

The runtime owns the transcript (ADR-0011): messages are stored in this
vendor-neutral form, and adapters translate to and from each vendor's wire
format on every call. Vendor-specific data that must round-trip unchanged
(thinking signatures, compaction blocks, server-tool blocks, OpenAI reasoning
items) is kept on the block with the vendor and model that produced it, so an
adapter can echo it back to the same model and drop it for any other.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Vendor = Literal["anthropic", "openai", "openai-compatible"]
Reasoning = Literal["low", "medium", "high"]


class _Block(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TextBlock(_Block):
    type: Literal["text"] = "text"
    text: str


class ThinkingBlock(_Block):
    """Model reasoning. ``raw`` is the vendor's block, echoed only to the same model."""

    type: Literal["thinking"] = "thinking"
    text: str = ""
    vendor: Vendor
    model: str
    raw: dict[str, Any] = Field(default_factory=dict)


class ToolCallBlock(_Block):
    """A tool call requested by the model, in canonical form.

    ``name`` is the canonical tool name the runtime executes (``shell``,
    ``files``, a function name). ``native_name`` is what the model called it
    (``bash``, ``str_replace_based_edit_tool``), which the adapter needs to
    send the result back in the native shape.
    """

    type: Literal["tool_call"] = "tool_call"
    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    native_name: str | None = None
    vendor: Vendor | None = None
    raw: dict[str, Any] = Field(default_factory=dict)
    parse_error: str | None = None


class ToolResultBlock(_Block):
    type: Literal["tool_result"] = "tool_result"
    call_id: str
    content: str
    is_error: bool = False
    native_name: str | None = None


class VendorBlock(_Block):
    """Opaque vendor content (server-tool blocks, compaction, reasoning items)."""

    type: Literal["vendor"] = "vendor"
    vendor: Vendor
    model: str
    raw: dict[str, Any]


Block = Annotated[
    TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock | VendorBlock,
    Field(discriminator="type"),
]


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: list[Block]

    @classmethod
    def user(cls, text: str) -> Message:
        return cls(role="user", content=[TextBlock(text=text)])

    @property
    def text(self) -> str:
        return "".join(b.text for b in self.content if isinstance(b, TextBlock))

    @property
    def tool_calls(self) -> list[ToolCallBlock]:
        return [b for b in self.content if isinstance(b, ToolCallBlock)]


class ToolSpec(BaseModel):
    """A tool as presented to a model.

    ``kind="builtin"`` tools (``shell``, ``files``, ``code``, ``web_search``,
    ``web_fetch``) are presented by each adapter with the schema its model was
    trained on (ADR-0009); ``input_schema`` is the canonical schema used for
    validation and for models without a native equivalent.
    """

    name: str
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})
    kind: Literal["function", "builtin"] = "function"
    options: dict[str, Any] = Field(default_factory=dict)


class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    def __add__(self, other: Usage) -> Usage:
        return Usage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            cache_read_tokens=self.cache_read_tokens + other.cache_read_tokens,
            cache_write_tokens=self.cache_write_tokens + other.cache_write_tokens,
        )


class ModelRequest(BaseModel):
    model: str
    system: str = ""
    messages: list[Message]
    tools: list[ToolSpec] = Field(default_factory=list)
    reasoning: Reasoning | None = None
    max_tokens: int = 64000
    options: dict[str, Any] = Field(default_factory=dict)
    """Raw, non-portable fields for this adapter (``model_options[vendor]``)."""


ModelStopReason = Literal["end_turn", "tool_use", "max_tokens", "refusal", "pause_turn", "error"]


class TextDelta(BaseModel):
    kind: Literal["text"] = "text"
    text: str


class ThinkingDelta(BaseModel):
    kind: Literal["thinking"] = "thinking"
    text: str


class ToolCallDelta(BaseModel):
    """Emitted when the model starts a tool call; arguments arrive in the final response."""

    kind: Literal["tool_call"] = "tool_call"
    id: str
    name: str


class ModelResponse(BaseModel):
    """The final delta of every stream: the full assistant message."""

    kind: Literal["response"] = "response"
    message: Message
    stop_reason: ModelStopReason
    usage: Usage = Field(default_factory=Usage)
    model: str
    refusal_category: str | None = None


ModelDelta = TextDelta | ThinkingDelta | ToolCallDelta | ModelResponse


class CapabilityManifest(BaseModel):
    """What a model can serve; registration rejects agents that ask for more (ADR-0003)."""

    vendor: Vendor
    model: str
    tools: bool = True
    streaming: bool = True
    parallel_tool_calls: bool = True
    reasoning: bool = False
    thinking_visible: bool = False
    prompt_caching: bool = False
    server_web_search: bool = False
    server_web_fetch: bool = False
    native_compaction: bool = False
    structured_outputs: bool = False
    vision: bool = False
    context_window: int | None = None
    max_output_tokens: int | None = None
    non_zdr_features: list[str] = Field(default_factory=list)

    def missing(self, required: set[str]) -> set[str]:
        return {f for f in required if not getattr(self, f, False)}
