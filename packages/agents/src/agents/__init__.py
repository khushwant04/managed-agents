"""Managed agents: define an agent once, run it locally, register and deploy it.

    from agents import Agent, Sandbox, tool
"""

from .adapters import AdapterRegistry
from .adapters.base import ModelError
from .agent import Agent
from .events import Event
from .runtime.runner import RunResult
from .sandbox import Environment, Sandbox
from .session import AsyncSession, Session
from .skills import Skill
from .spec import AgentSpec, Limits, SubagentPolicy, ToolRef
from .tools.function import FunctionTool, tool

__version__ = "0.1.0.dev0"

__all__ = [
    "AdapterRegistry",
    "Agent",
    "AgentSpec",
    "AsyncSession",
    "Environment",
    "Event",
    "FunctionTool",
    "Limits",
    "ModelError",
    "RunResult",
    "Sandbox",
    "Session",
    "Skill",
    "SubagentPolicy",
    "ToolRef",
    "tool",
]
