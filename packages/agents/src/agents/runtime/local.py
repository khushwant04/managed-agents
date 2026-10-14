"""The embedded runtime: sessions hosted in-process, for scripts and tests.

The same ``Runner`` runs inside hosted workers; this module plays the part of
the hosting layer (sessions, sandboxes, status, steering, approvals,
subagents) with in-memory stores.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ..adapters import AdapterRegistry
from ..events import Event, SessionStatus, new_id
from ..sandbox import Sandbox
from ..sandbox.base import FileSpec, SandboxHandle
from ..skills import Skill
from ..spec import AgentSpec
from ..store.base import EventLog, StepSpec, StepStore
from ..store.memory import InMemoryEventLog, InMemoryStepStore
from ..tools.executor import CallContext, ToolExecutionError, ToolExecutor, ToolHandler
from ..tools.function import FunctionTool
from ..types import Message
from .runner import RunContext, Runner, RunResult, SteeringQueue
from .toolset import needs_sandbox, system_prompt, tool_specs

if TYPE_CHECKING:
    from ..agent import Agent

_STOP_TO_STATUS: dict[str, SessionStatus] = {
    "end_turn": "idle",
    "needs_input": "waiting_input",
    "approval_pending": "approval_pending",
    "budget": "idle",
    "interrupted": "idle",
    "error": "failed",
}
SETTLED: frozenset[str] = frozenset({"idle", "waiting_input", "approval_pending", "failed", "terminated"})


@dataclass
class _SessionState:
    id: str
    spec: AgentSpec
    functions: dict[str, FunctionTool]
    skills: list[Skill]
    sandbox: Sandbox | None
    handle: SandboxHandle | None = None
    depth: int = 0
    agents: dict[str, Agent] = field(default_factory=dict)
    run_id: str | None = None
    task: asyncio.Task[RunResult] | None = None
    steering: SteeringQueue = field(default_factory=SteeringQueue)
    last_result: RunResult | None = None
    status: SessionStatus = "queued"
    subagent_slots: asyncio.Semaphore | None = None


class LocalRuntime:
    def __init__(
        self,
        adapters: AdapterRegistry | None = None,
        steps: StepStore | None = None,
        events: EventLog | None = None,
    ) -> None:
        self.adapters = adapters or AdapterRegistry()
        self.steps = steps or InMemoryStepStore()
        self.events = events or InMemoryEventLog()
        self.runner = Runner(self.adapters, self.steps, self.events)
        self.sessions: dict[str, _SessionState] = {}

    # -- lifecycle --------------------------------------------------------

    async def create_session(
        self,
        spec: AgentSpec,
        *,
        functions: dict[str, FunctionTool] | None = None,
        skills: list[Skill] | None = None,
        sandbox: Sandbox | None = None,
        agents: dict[str, Agent] | None = None,
        depth: int = 0,
        handle: SandboxHandle | None = None,
    ) -> str:
        state = _SessionState(
            id=new_id("ses"),
            spec=spec,
            functions=functions or {},
            skills=skills or [],
            sandbox=sandbox,
            depth=depth,
            agents=agents or {},
            handle=handle,
        )
        if spec.subagents is not None:
            state.subagent_slots = asyncio.Semaphore(spec.subagents.max_concurrent)
        self.sessions[state.id] = state
        if state.handle is None and needs_sandbox(spec):
            if state.sandbox is None:
                state.sandbox = Sandbox.local()
            state.handle = await state.sandbox.provider.create(state.sandbox.env)
            files = [f for s in state.skills for f in s.sandbox_files()]
            if files:
                await state.sandbox.provider.write_files(state.handle, files)
        await self._status(state, "queued")
        return state.id

    async def _status(self, state: _SessionState, status: SessionStatus, **extra: Any) -> None:
        state.status = status
        await self.events.append(
            Event(session_id=state.id, run_id=state.run_id, type="session.status", payload={"status": status, **extra})
        )

    def _executor(self, state: _SessionState) -> ToolExecutor:
        specs = {t.name: t for t in tool_specs(state.spec)}
        handlers: dict[str, ToolHandler] = {}
        if state.spec.subagents is not None:
            handlers["spawn_subagent"] = lambda args, ctx: self._spawn_subagent(state, args, ctx)
        for ref in state.spec.tools:
            if ref.type == "agent":
                handlers[ref.name] = lambda args, ctx, ref=ref: self._call_agent(state, ref.options.get("agent", ref.name), args, ctx)
        return ToolExecutor(
            specs,
            sandbox=state.sandbox.provider if state.sandbox else None,
            handle=state.handle,
            functions=state.functions,
            handlers=handlers,
        )

    async def send(self, session_id: str, text: str | Message) -> str:
        """Start a run with this input, or steer the running one."""
        state = self.sessions[session_id]
        message = text if isinstance(text, Message) else Message.user(text)
        if state.task is not None and not state.task.done():
            state.steering.put(message)
            return state.run_id or ""
        state.run_id = new_id("run")
        state.steering = SteeringQueue()
        state.task = asyncio.create_task(self._run(state, [message]))
        return state.run_id

    async def _run(self, state: _SessionState, inputs: list[Message]) -> RunResult:
        assert state.run_id is not None
        if state.sandbox and state.handle and state.status == "idle":
            state.handle = await state.sandbox.provider.resume(state.handle)
        await self._status(state, "running")
        ctx = RunContext(
            session_id=state.id,
            run_id=state.run_id,
            spec=state.spec,
            executor=self._executor(state),
            tools=tool_specs(state.spec),
            inputs=inputs,
            system=system_prompt(state.spec, has_sandbox=state.handle is not None),
            steering=state.steering,
        )
        try:
            result = await self.runner.run(ctx)
        except asyncio.CancelledError:
            state.last_result = RunResult(run_id=state.run_id, stop_reason="interrupted")
            await self._status(state, "idle", stop_reason="interrupted")
            raise
        except Exception as exc:
            state.last_result = RunResult(run_id=state.run_id, stop_reason="error", error=str(exc))
            await self.events.append(
                Event(session_id=state.id, run_id=state.run_id, type="error", payload={"message": str(exc), "fatal": True})
            )
            await self._status(state, "failed", error=str(exc))
            return state.last_result
        state.last_result = result
        await self._status(state, _STOP_TO_STATUS[result.stop_reason], stop_reason=result.stop_reason)
        return result

    async def resume(self, session_id: str) -> None:
        """Re-run the current run from its checkpoints (after approval or a crash)."""
        state = self.sessions[session_id]
        if state.task is not None and not state.task.done():
            return
        state.task = asyncio.create_task(self._run(state, []))

    async def approve(self, session_id: str, call_id: str, approved: bool = True, reason: str | None = None) -> None:
        state = self.sessions[session_id]
        if state.run_id is None:
            raise ValueError("session has no run waiting for approval")
        step = await self.steps.get(state.run_id, f"approval:{call_id}")
        if step is None:
            raise ValueError(f"no approval requested for call {call_id!r}")
        if step.status == "completed":
            return
        await self.steps.complete(step.id, {"approved": approved, "reason": reason})
        await self.events.append(
            Event(
                session_id=state.id,
                run_id=state.run_id,
                type="tool.approval.decided",
                payload={"call_id": call_id, "approved": approved, "reason": reason},
            )
        )
        pending = [
            r for r in (state.last_result.pending_approvals if state.last_result else []) if r["call_id"] != call_id
        ]
        undecided = []
        for r in pending:
            s = await self.steps.get(state.run_id, f"approval:{r['call_id']}")
            if s is None or s.status != "completed":
                undecided.append(r)
        if not undecided:
            await self.resume(session_id)

    async def interrupt(self, session_id: str) -> None:
        state = self.sessions[session_id]
        if state.task is not None and not state.task.done():
            state.task.cancel()
            try:
                await state.task
            except asyncio.CancelledError:
                pass

    async def wait(self, session_id: str) -> RunResult | None:
        state = self.sessions[session_id]
        if state.task is not None:
            try:
                await asyncio.shield(state.task)
            except asyncio.CancelledError:
                pass
        return state.last_result

    async def close(self, session_id: str) -> None:
        state = self.sessions[session_id]
        await self.interrupt(session_id)
        if state.sandbox and state.handle and state.depth == 0:
            await state.sandbox.provider.destroy(state.handle)
        await self._status(state, "terminated")
        close = getattr(self.events, "close", None)
        if close is not None:
            await close(session_id)

    async def read_outputs(self, session_id: str) -> list[FileSpec]:
        state = self.sessions[session_id]
        if not state.sandbox or not state.handle:
            return []
        listing = await state.sandbox.provider.exec(state.handle, "find /workspace/outputs -type f | sort", timeout=30)
        paths = [p for p in listing.stdout.splitlines() if p.strip()]
        local_root = state.handle.data.get("dir")
        if local_root:
            paths = [p.replace(local_root, "/workspace", 1) for p in paths]
        return await state.sandbox.provider.read_files(state.handle, paths) if paths else []

    async def stream(self, session_id: str, after_seq: int = 0) -> AsyncIterator[Event]:
        async for ev in self.events.subscribe(session_id, after_seq):
            yield ev

    # -- delegation -------------------------------------------------------

    async def _spawn_subagent(self, parent: _SessionState, args: dict[str, Any], ctx: CallContext) -> str:
        policy = parent.spec.subagents
        assert policy is not None and parent.subagent_slots is not None
        allowed = set(policy.tools or [t.name for t in parent.spec.tools])
        if args.get("tools"):
            allowed &= set(args["tools"])
        child_spec = parent.spec.model_copy(
            update={
                "tools": [t for t in parent.spec.tools if t.name in allowed],
                "subagents": policy if parent.depth + 1 < policy.max_depth else None,
                "skills": parent.spec.skills,
            }
        )
        async with parent.subagent_slots:
            child_id = await self.create_session(
                child_spec,
                functions=parent.functions,
                sandbox=parent.sandbox,
                handle=parent.handle,
                depth=parent.depth + 1,
                agents=parent.agents,
            )
            await self.events.append(
                Event(session_id=parent.id, run_id=ctx.run_id, type="subagent.started", payload={"child_session_id": child_id, "task": args["task"]})
            )
            await self.send(child_id, args["task"])
            result = await self.wait(child_id)
            await self.events.append(
                Event(
                    session_id=parent.id,
                    run_id=ctx.run_id,
                    type="subagent.finished",
                    payload={"child_session_id": child_id, "stop_reason": result.stop_reason if result else None},
                )
            )
        if result is None or result.stop_reason not in ("end_turn", "budget"):
            raise ToolExecutionError(f"subagent stopped: {result.stop_reason if result else 'unknown'} {result.error if result else ''}")
        return result.output or "(the subagent returned no text)"

    async def _call_agent(self, parent: _SessionState, target: str, args: dict[str, Any], ctx: CallContext) -> str:
        name = target.split("@", 1)[0]
        agent = parent.agents.get(name)
        if agent is None:
            raise ToolExecutionError(f"agent {target!r} is not available in this local runtime")
        max_depth = parent.spec.subagents.max_depth if parent.spec.subagents else 3
        if parent.depth + 1 > max_depth:
            raise ToolExecutionError(f"call_agent depth limit ({max_depth}) reached")
        child_id = await self.create_session(
            agent.spec(), functions=agent.functions, skills=agent.skills, sandbox=parent.sandbox, depth=parent.depth + 1, agents=agent.agents
        )
        await self.events.append(
            Event(session_id=parent.id, run_id=ctx.run_id, type="subagent.started", payload={"child_session_id": child_id, "agent": target})
        )
        await self.send(child_id, args["input"])
        result = await self.wait(child_id)
        await self.close(child_id)
        await self.events.append(
            Event(session_id=parent.id, run_id=ctx.run_id, type="subagent.finished", payload={"child_session_id": child_id, "agent": target})
        )
        if result is None or result.stop_reason not in ("end_turn", "budget"):
            raise ToolExecutionError(f"{target} stopped: {result.stop_reason if result else 'unknown'}")
        return result.output


async def record_step(steps: StepStore, session_id: str, run_id: str, key: str, type_: Any, output: dict[str, Any]) -> None:
    """Write a completed step directly (used by tests and the hosting layer)."""
    sid = await steps.begin(StepSpec(session_id=session_id, run_id=run_id, key=key, type=type_))
    await steps.complete(sid, output)
