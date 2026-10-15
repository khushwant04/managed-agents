"""Turns an agent's tool references into tool specs and executor handlers."""

from __future__ import annotations

from typing import Any

from ..skills import skills_prompt
from ..spec import AgentSpec
from ..tools.builtins import BUILTINS, builtin
from ..types import ToolSpec

WORKSPACE_NOTE = (
    "## Workspace\n"
    "You work in a sandbox. /workspace is the working directory: inputs are in /workspace/inputs, "
    "and files you write to /workspace/outputs are returned to the user as artifacts."
)

CALL_AGENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "input": {"type": "string", "description": "The task or question for the agent."},
    },
    "required": ["input"],
    "additionalProperties": False,
}

SPAWN_SUBAGENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "task": {"type": "string", "description": "A complete, self-contained task for the subagent."},
        "tools": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Optional subset of your tools the subagent may use.",
        },
    },
    "required": ["task"],
    "additionalProperties": False,
}


def tool_specs(spec: AgentSpec, mcp_tools: list[ToolSpec] | None = None) -> list[ToolSpec]:
    """Tool specs in a stable order, so the prompt prefix stays cacheable."""
    out: list[ToolSpec] = []
    for ref in spec.tools:
        if ref.type == "builtin":
            out.append(builtin(ref.name, **ref.options))
        elif ref.type == "function":
            out.append(
                ToolSpec(
                    name=ref.name,
                    description=ref.description,
                    input_schema=ref.input_schema or {"type": "object", "properties": {}},
                )
            )
        elif ref.type == "agent":
            out.append(
                ToolSpec(
                    name=ref.name,
                    description=ref.description or f"Delegate a task to the {ref.options.get('agent', ref.name)} agent.",
                    input_schema=CALL_AGENT_SCHEMA,
                )
            )
    out.extend(sorted(mcp_tools or [], key=lambda t: t.name))
    if spec.subagents is not None:
        out.append(
            ToolSpec(
                name="spawn_subagent",
                description=(
                    "Start a subagent with its own context to work on a self-contained task, and get its "
                    "final answer back. Use it for research or work that would otherwise fill your context."
                ),
                input_schema=SPAWN_SUBAGENT_SCHEMA,
            )
        )
    return out


def system_prompt(spec: AgentSpec, *, has_sandbox: bool) -> str:
    parts = [spec.instructions.strip()] if spec.instructions.strip() else []
    if has_sandbox and any(t.type == "builtin" and t.name in ("shell", "files", "code") for t in spec.tools):
        parts.append(WORKSPACE_NOTE)
    if spec.skills:
        parts.append(skills_prompt(spec.skills))
    return "\n\n".join(parts)


def needs_sandbox(spec: AgentSpec) -> bool:
    return bool(spec.skills) or any(
        t.type == "builtin" and t.name in ("shell", "files", "code") for t in spec.tools
    )


__all__ = ["BUILTINS", "needs_sandbox", "system_prompt", "tool_specs"]
