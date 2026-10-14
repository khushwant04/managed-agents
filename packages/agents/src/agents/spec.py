"""The serializable agent definition stored as an immutable, content-hashed version (ADR-0004)."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .sandbox.base import Environment
from .tools.approval import parse_approval
from .types import Reasoning

ToolType = Literal["builtin", "function", "mcp", "agent"]


class ToolRef(BaseModel):
    """A tool reference inside an agent version.

    - ``builtin``: ``shell``, ``files``, ``code``, ``web_search``, ``web_fetch``
    - ``function``: schema plus an optional webhook ``url``
    - ``mcp``: an MCP server ``url``; its tools are listed at run start
    - ``agent``: another registered agent, called through the router (``call_agent``)
    """

    model_config = ConfigDict(extra="forbid")

    type: ToolType
    name: str
    description: str = ""
    input_schema: dict[str, Any] | None = None
    url: str | None = None
    approval: Any = "never"
    secrets: list[str] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)

    @field_validator("approval")
    @classmethod
    def _check_approval(cls, value: Any) -> Any:
        return parse_approval(value).to_json()


class SkillRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    version: str | None = None
    description: str = ""
    path: str | None = None
    """Local folder (development) or bundle key (registered skill)."""


class SubagentPolicy(BaseModel):
    max_concurrent: int = 3
    max_depth: int = 2
    tools: list[str] | None = None
    """Tool names children may use; defaults to the parent's minus ``spawn_subagent``."""


class Limits(BaseModel):
    max_steps: int = 100
    max_tokens: int | None = None
    """Total input + output tokens per run."""
    max_wall_clock_s: float | None = None
    max_output_tokens: int = 64_000
    compact_at_tokens: int | None = None
    """Estimated context size that triggers compaction; defaults to 75% of the model's window."""


class AgentSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,62}$")
    description: str = ""
    models: list[str] = Field(min_length=1)
    instructions: str = ""
    tools: list[ToolRef] = Field(default_factory=list)
    skills: list[SkillRef] = Field(default_factory=list)
    reasoning: Reasoning | None = None
    subagents: SubagentPolicy | None = None
    model_options: dict[str, dict[str, Any]] = Field(default_factory=dict)
    limits: Limits = Field(default_factory=Limits)
    environment: Environment | None = None
    input_schema: dict[str, Any] | None = None
    tags: list[str] = Field(default_factory=list)

    def content_hash(self) -> str:
        canonical = json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()

    def tool(self, name: str) -> ToolRef | None:
        return next((t for t in self.tools if t.name == name), None)

    def card(self, endpoint: str | None = None, version: int | None = None) -> dict[str, Any]:
        """An agent card, following the shape of the A2A agent card."""
        return {
            "name": self.name,
            "description": self.description,
            "version": str(version) if version is not None else None,
            "url": endpoint,
            "capabilities": {"streaming": True},
            "defaultInputModes": ["text"],
            "defaultOutputModes": ["text"],
            "skills": [{"id": s.name, "name": s.name, "description": s.description} for s in self.skills],
            "inputSchema": self.input_schema,
            "tags": self.tags,
        }
