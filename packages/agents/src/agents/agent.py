"""``Agent``: one definition that runs locally and deploys unchanged."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .adapters import AdapterRegistry
from .sandbox import Sandbox
from .sandbox.base import Environment
from .skills import Skill
from .spec import AgentSpec, Limits, SubagentPolicy, ToolRef
from .tools.builtins import BUILTINS
from .tools.function import FunctionTool
from .types import Reasoning


class Agent:
    """An agent definition.

    ``tools`` accepts built-in names (``"shell"``, ``"files"``, ``"code"``,
    ``"web_search"``, ``"web_fetch"``), ``@tool`` functions, MCP servers as
    ``{"mcp": url, "secret": name}``, other ``Agent`` objects (called through
    ``call_agent``), and ``{"agent": "name@alias"}`` references to registered
    agents. ``skills`` accepts folder paths or ``Skill`` objects.
    """

    def __init__(
        self,
        name: str,
        model: str | list[str],
        instructions: str = "",
        *,
        tools: list[Any] | None = None,
        skills: list[str | Path | Skill] | None = None,
        reasoning: Reasoning | None = None,
        subagents: dict[str, Any] | SubagentPolicy | None = None,
        model_options: dict[str, dict[str, Any]] | None = None,
        limits: dict[str, Any] | Limits | None = None,
        environment: Environment | dict[str, Any] | None = None,
        description: str = "",
        input_schema: dict[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> None:
        self.name = name
        self.models = [model] if isinstance(model, str) else list(model)
        self.instructions = instructions
        self.reasoning = reasoning
        self.description = description
        self.input_schema = input_schema
        self.tags = tags or []
        self.model_options = model_options or {}
        self.subagents = SubagentPolicy.model_validate(subagents) if isinstance(subagents, dict) else subagents
        self.limits = Limits.model_validate(limits) if isinstance(limits, dict) else (limits or Limits())
        self.environment = Environment.model_validate(environment) if isinstance(environment, dict) else environment
        self.functions: dict[str, FunctionTool] = {}
        self.agents: dict[str, Agent] = {}
        self.tool_refs: list[ToolRef] = [self._tool_ref(t) for t in (tools or [])]
        self.skills: list[Skill] = []
        self.skill_paths: dict[str, str] = {}
        for s in skills or []:
            skill = s if isinstance(s, Skill) else Skill.from_path(s)
            self.skills.append(skill)
            if not isinstance(s, Skill):
                self.skill_paths[skill.name] = str(s)
        self.spec()  # validate early

    def _tool_ref(self, t: Any) -> ToolRef:
        if isinstance(t, str):
            if t not in BUILTINS:
                raise ValueError(f"unknown built-in tool {t!r}; expected one of {sorted(BUILTINS)}")
            return ToolRef(type="builtin", name=t)
        if isinstance(t, FunctionTool):
            self.functions[t.name] = t
            return ToolRef.model_validate(t.ref())
        if isinstance(t, Agent):
            self.agents[t.name] = t
            return ToolRef(
                type="agent",
                name=f"call_{t.name.replace('-', '_')}",
                description=t.description or f"Delegate a task to the {t.name} agent and get its answer.",
                options={"agent": t.name},
            )
        if isinstance(t, ToolRef):
            return t
        if isinstance(t, dict):
            if "mcp" in t:
                url = t["mcp"]
                return ToolRef(
                    type="mcp",
                    name=t.get("name") or _mcp_name(url),
                    url=url,
                    secrets=[t["secret"]] if t.get("secret") else [],
                    approval=t.get("approval", "never"),
                    options={k: v for k, v in t.items() if k not in ("mcp", "name", "secret", "approval")},
                )
            if "agent" in t:
                target = t["agent"]
                return ToolRef(
                    type="agent",
                    name=t.get("name") or f"call_{target.split('@')[0].replace('-', '_')}",
                    description=t.get("description", ""),
                    approval=t.get("approval", "never"),
                    options={"agent": target},
                )
            if "builtin" in t:
                return ToolRef(
                    type="builtin",
                    name=t["builtin"],
                    approval=t.get("approval", "never"),
                    options={k: v for k, v in t.items() if k not in ("builtin", "approval")},
                )
            return ToolRef.model_validate(t)
        raise TypeError(f"unsupported tool {t!r}")

    def spec(self) -> AgentSpec:
        return AgentSpec(
            name=self.name,
            description=self.description,
            models=self.models,
            instructions=self.instructions,
            tools=self.tool_refs,
            skills=[s.ref(self.skill_paths.get(s.name)) for s in self.skills],
            reasoning=self.reasoning,
            subagents=self.subagents,
            model_options=self.model_options,
            limits=self.limits,
            environment=self.environment,
            input_schema=self.input_schema,
            tags=self.tags,
        )

    @classmethod
    def from_spec(cls, spec: AgentSpec, *, functions: list[FunctionTool] | None = None) -> Agent:
        agent = cls.__new__(cls)
        agent.name = spec.name
        agent.models = list(spec.models)
        agent.instructions = spec.instructions
        agent.reasoning = spec.reasoning
        agent.description = spec.description
        agent.input_schema = spec.input_schema
        agent.tags = list(spec.tags)
        agent.model_options = dict(spec.model_options)
        agent.subagents = spec.subagents
        agent.limits = spec.limits
        agent.environment = spec.environment
        agent.functions = {f.name: f for f in functions or []}
        agent.agents = {}
        agent.tool_refs = list(spec.tools)
        agent.skills = [Skill.from_path(s.path) for s in spec.skills if s.path and Path(s.path).is_dir()]
        agent.skill_paths = {s.name: s.path for s in spec.skills if s.path}
        return agent

    @classmethod
    def from_yaml(cls, path: str | Path) -> Agent:
        p = Path(path)
        data = yaml.safe_load(p.read_text())
        model = data.pop("model", None)
        if model is not None:
            data["models"] = [model] if isinstance(model, str) else model
        tools = [_yaml_tool(t) for t in data.pop("tools", [])]
        skills = [str((p.parent / s).resolve()) if isinstance(s, str) else s for s in data.pop("skills", [])]
        spec = AgentSpec.model_validate({**data, "tools": [], "skills": []})
        agent = cls.from_spec(spec)
        agent.tool_refs = [agent._tool_ref(t) for t in tools]
        for s in skills:
            skill = Skill.from_path(s)
            agent.skills.append(skill)
            agent.skill_paths[skill.name] = s
        agent.spec()
        return agent

    @property
    def version_hash(self) -> str:
        return self.spec().content_hash()

    # -- running locally --------------------------------------------------

    def start(
        self,
        input: str | None = None,
        *,
        sandbox: Sandbox | None = None,
        adapters: AdapterRegistry | None = None,
    ) -> Any:
        """Start a local session in a background event loop (sync API)."""
        from .session import Session

        return Session.start(self, input, sandbox=sandbox, adapters=adapters)

    async def astart(
        self,
        input: str | None = None,
        *,
        sandbox: Sandbox | None = None,
        adapters: AdapterRegistry | None = None,
    ) -> Any:
        """Start a local session on the running event loop (async API)."""
        from .session import AsyncSession

        return await AsyncSession.start(self, input, sandbox=sandbox, adapters=adapters)

    def run(self, input: str, **kwargs: Any) -> str:
        """Run one turn to completion and return the final text."""
        session = self.start(input, **kwargs)
        try:
            result = session.wait()
            if result is not None and result.stop_reason == "error":
                raise RuntimeError(result.error)
            return session.output
        finally:
            session.close()


def _mcp_name(url: str) -> str:
    from urllib.parse import urlparse

    host = urlparse(url).hostname or "mcp"
    return host.split(".")[0].replace("-", "_")


def _yaml_tool(t: Any) -> Any:
    if isinstance(t, dict) and "url" in t and "name" in t and "type" not in t:
        return {**t, "type": "function"}
    return t
