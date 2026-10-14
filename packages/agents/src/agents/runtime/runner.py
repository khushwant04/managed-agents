"""The agent loop: a step machine over durable steps.

Build context, call the model, run the tools it asks for, append the results,
and repeat until the model ends its turn, a limit is hit, or a tool call needs
approval. Each model call, tool call, steering input and compaction is a step
checkpointed in the ``StepStore``; resuming a run replays completed steps
without re-executing them or re-emitting their events.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .. import tracing
from ..adapters import AdapterRegistry
from ..adapters.base import ModelError
from ..events import Event, EventType, RunStopReason
from ..spec import AgentSpec
from ..store.base import EventLog, StepSpec, StepStore
from ..tools.approval import parse_approval
from ..tools.executor import CallContext, ToolExecutor
from ..types import (
    Message,
    ModelRequest,
    ModelResponse,
    TextBlock,
    TextDelta,
    ThinkingDelta,
    ToolCallBlock,
    ToolResultBlock,
    ToolSpec,
    Usage,
)
from .transcript import TranscriptBuilder

COMPACTION_PROMPT = (
    "Your context window is nearly full. Write a summary of the conversation so far that lets you "
    "continue the task without the earlier messages: the user's goal and constraints, what you have "
    "done and found, files you created or changed, decisions made, and the next steps. Do not call "
    "any tools; reply with the summary only."
)


class SteeringQueue:
    """Input sent mid-run; injected at the next step boundary.

    The hosted runtime subclasses this to read queued input from Postgres.
    """

    def __init__(self) -> None:
        self._items: list[Message] = []

    def put(self, message: Message) -> None:
        self._items.append(message)

    async def take(self) -> list[Message]:
        items, self._items = self._items, []
        return items

    async def pending(self) -> bool:
        return bool(self._items)


@dataclass
class RunContext:
    session_id: str
    run_id: str
    spec: AgentSpec
    executor: ToolExecutor
    tools: list[ToolSpec]
    inputs: list[Message] = field(default_factory=list)
    system: str | None = None
    steering: SteeringQueue = field(default_factory=SteeringQueue)
    history: list[Message] | None = None
    """Transcript before this run; derived from the session's steps when omitted."""
    attributes: dict[str, Any] = field(default_factory=dict)
    """Extra span attributes, such as the agent version and resolved alias."""


@dataclass
class RunResult:
    run_id: str
    stop_reason: RunStopReason
    usage: Usage = field(default_factory=Usage)
    output: str = ""
    error: str | None = None
    pending_approvals: list[dict[str, Any]] = field(default_factory=list)
    model: str | None = None


class _Budget(Exception):
    pass


class Runner:
    def __init__(
        self,
        adapters: AdapterRegistry,
        steps: StepStore,
        events: EventLog,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.adapters = adapters
        self.steps = steps
        self.events = events
        self.clock = clock

    async def _emit(self, ctx: RunContext, type: EventType, payload: dict[str, Any], model: str | None = None) -> None:
        await self.events.append(
            Event(session_id=ctx.session_id, run_id=ctx.run_id, type=type, payload=payload, model=model)
        )

    # -- the loop ---------------------------------------------------------

    async def run(self, ctx: RunContext) -> RunResult:
        attrs = tracing.run_attributes(agent=ctx.spec.name, session_id=ctx.session_id, run_id=ctx.run_id, extra=ctx.attributes)
        with tracing.span(f"invoke_agent {ctx.spec.name}", attrs) as sp:
            result = await self._run(ctx)
            sp.set_attributes(
                {
                    "agents.stop_reason": result.stop_reason,
                    "gen_ai.usage.input_tokens": result.usage.input_tokens,
                    "gen_ai.usage.output_tokens": result.usage.output_tokens,
                }
            )
            return result

    async def _run(self, ctx: RunContext) -> RunResult:
        spec = ctx.spec
        started = self.clock()
        usage = Usage()
        last_model: str | None = None
        system = ctx.system if ctx.system is not None else spec.instructions

        if ctx.history is not None:
            builder = TranscriptBuilder(ctx.history)
        else:
            builder = TranscriptBuilder()
            for s in await self.steps.session_steps(ctx.session_id):
                if s.run_id != ctx.run_id:
                    builder.add(s)
        resumed = await self.steps.last_completed(ctx.run_id) is not None

        # Input for this run is step "input:0".
        done = await self.steps.get(ctx.run_id, "input:0")
        if done is None or done.status != "completed":
            if not resumed:
                await self._emit(ctx, "run.started", {"agent": spec.name})
            sid = await self.steps.begin(
                StepSpec(session_id=ctx.session_id, run_id=ctx.run_id, key="input:0", type="input")
            )
            out = {"messages": [m.model_dump(mode="json") for m in ctx.inputs]}
            await self.steps.complete(sid, out)
            for m in ctx.inputs:
                await self._emit(ctx, "message.user", {"text": m.text, "message": m.model_dump(mode="json")})
            done = await self.steps.get(ctx.run_id, "input:0")
        assert done is not None
        builder.add(done)

        try:
            step = 0
            while True:
                if step >= spec.limits.max_steps:
                    raise _Budget(f"reached max_steps ({spec.limits.max_steps})")
                if spec.limits.max_wall_clock_s and self.clock() - started > spec.limits.max_wall_clock_s:
                    raise _Budget(f"reached max_wall_clock_s ({spec.limits.max_wall_clock_s})")
                if spec.limits.max_tokens and usage.input_tokens + usage.output_tokens > spec.limits.max_tokens:
                    raise _Budget(f"reached max_tokens ({spec.limits.max_tokens})")

                await self._steer(ctx, builder, step)
                await self._maybe_compact(ctx, builder, step, system)

                response = await self._model_step(ctx, builder.build(), step, system)
                usage = usage + response.usage
                last_model = response.model
                fake_step = _completed("model", ctx, {"message": response.message.model_dump(mode="json")})
                builder.add(fake_step)
                step += 1

                if response.stop_reason == "pause_turn":
                    continue
                if response.stop_reason == "refusal":
                    return await self._finish(ctx, "error", usage, builder, last_model, error="the model declined the request (refusal)")

                calls = response.message.tool_calls
                if not calls:
                    if await ctx.steering.pending():
                        continue  # input arrived while the model was answering
                    return await self._finish(ctx, "end_turn", usage, builder, last_model)

                results: dict[str, ToolResultBlock] = {}
                if response.stop_reason == "max_tokens":
                    for c in calls:
                        results[c.id] = ToolResultBlock(
                            call_id=c.id,
                            content="Tool input was cut off by the output token limit; send a shorter call.",
                            is_error=True,
                            native_name=c.native_name,
                        )
                pending = await self._approvals(ctx, [c for c in calls if c.id not in results], results)
                if pending:
                    builder.add_results(results.values())
                    return await self._finish(
                        ctx, "approval_pending", usage, builder, last_model, pending_approvals=pending
                    )
                todo = [c for c in calls if c.id not in results]
                for r in await asyncio.gather(*(self._tool_step(ctx, c) for c in todo)):
                    results[r.call_id] = r
                builder.add_results(results.values())
        except _Budget as exc:
            return await self._finish(ctx, "budget", usage, builder, last_model, error=str(exc))
        except ModelError as exc:
            await self._emit(ctx, "error", {"kind": exc.kind, "message": str(exc), "fatal": True})
            return await self._finish(ctx, "error", usage, builder, last_model, error=str(exc))
        except asyncio.CancelledError:
            await self._finish(ctx, "interrupted", usage, builder, last_model)
            raise

    async def _finish(
        self,
        ctx: RunContext,
        stop: RunStopReason,
        usage: Usage,
        builder: TranscriptBuilder,
        model: str | None,
        *,
        error: str | None = None,
        pending_approvals: list[dict[str, Any]] | None = None,
    ) -> RunResult:
        messages = builder.build()
        output = next((m.text for m in reversed(messages) if m.role == "assistant" and m.text), "")
        payload: dict[str, Any] = {"stop_reason": stop, "usage": usage.model_dump()}
        if error:
            payload["error"] = error
        if pending_approvals:
            payload["pending_approvals"] = pending_approvals
        await self._emit(ctx, "run.finished", payload, model=model)
        return RunResult(
            run_id=ctx.run_id,
            stop_reason=stop,
            usage=usage,
            output=output,
            error=error,
            pending_approvals=pending_approvals or [],
            model=model,
        )

    # -- steps ------------------------------------------------------------

    async def _steer(self, ctx: RunContext, builder: TranscriptBuilder, step: int) -> None:
        key = f"steer:{step}"
        done = await self.steps.get(ctx.run_id, key)
        messages = await ctx.steering.take() if done is None else []
        if messages:
            sid = await self.steps.begin(StepSpec(session_id=ctx.session_id, run_id=ctx.run_id, key=key, type="input"))
            await self.steps.complete(sid, {"messages": [m.model_dump(mode="json") for m in messages]})
            for m in messages:
                await self._emit(ctx, "message.user", {"text": m.text, "steering": True})
            done = await self.steps.get(ctx.run_id, key)
        if done is not None and done.status == "completed":
            builder.add(done)

    async def _model_step(self, ctx: RunContext, messages: list[Message], step: int, system: str) -> ModelResponse:
        key = f"model:{step}"
        done = await self.steps.get(ctx.run_id, key)
        if done is not None and done.status == "completed" and done.output:
            return ModelResponse.model_validate(done.output["response"])
        sid = await self.steps.begin(
            StepSpec(session_id=ctx.session_id, run_id=ctx.run_id, key=key, type="model", input={"models": ctx.spec.models})
        )
        response = await self._call_models(ctx, messages, system)
        await self.steps.complete(
            sid,
            {"message": response.message.model_dump(mode="json"), "response": response.model_dump(mode="json")},
        )
        if response.message.text:
            await self._emit(ctx, "message.agent.done", {"text": response.message.text}, model=response.model)
        for call in response.message.tool_calls:
            await self._emit(
                ctx, "tool.call", {"id": call.id, "name": call.name, "arguments": call.arguments}, model=response.model
            )
        return response

    async def _call_models(
        self, ctx: RunContext, messages: list[Message], system: str, *, tools: list[ToolSpec] | None = None
    ) -> ModelResponse:
        """Try the agent's models in order; fall back on 429, 5xx, connection errors and refusals."""
        spec = ctx.spec
        last_error: ModelError | None = None
        for i, model in enumerate(spec.models):
            adapter, name = self.adapters.resolve(model)
            req = ModelRequest(
                model=name,
                system=system,
                messages=messages,
                tools=ctx.tools if tools is None else tools,
                reasoning=spec.reasoning,
                max_tokens=spec.limits.max_output_tokens,
                options=spec.model_options.get(adapter.id, {}),
            )
            response: ModelResponse | None = None
            try:
                with tracing.span(f"chat {name}", tracing.model_attributes(vendor=adapter.id, model=name, extra=ctx.attributes)) as sp:
                    async for delta in adapter.stream(req):
                        if isinstance(delta, TextDelta):
                            await self._emit(ctx, "message.agent.delta", {"text": delta.text}, model=name)
                        elif isinstance(delta, ThinkingDelta):
                            await self._emit(ctx, "thinking.delta", {"text": delta.text}, model=name)
                        elif isinstance(delta, ModelResponse):
                            response = delta
                            sp.set_attributes(tracing.usage_attributes(delta))
            except ModelError as exc:
                if not exc.should_fall_back or i == len(spec.models) - 1:
                    raise
                last_error = exc
                await self._emit(
                    ctx,
                    "error",
                    {"kind": "model_fallback", "reason": exc.kind, "message": str(exc), "from": model, "to": spec.models[i + 1], "fatal": False},
                )
                continue
            if response is None:
                raise ModelError("server", f"{model} stream ended without a response")
            if response.stop_reason == "refusal" and i < len(spec.models) - 1:
                await self._emit(
                    ctx,
                    "error",
                    {"kind": "model_fallback", "reason": "refusal", "message": "refusal", "from": model, "to": spec.models[i + 1], "fatal": False},
                )
                continue
            return response
        raise last_error or ModelError("server", "no model produced a response")

    async def _approvals(
        self, ctx: RunContext, calls: list[ToolCallBlock], results: dict[str, ToolResultBlock]
    ) -> list[dict[str, Any]]:
        """Resolve approval policy for each call; return the calls still waiting for a decision."""
        pending: list[dict[str, Any]] = []
        for call in calls:
            ref = ctx.spec.tool(call.name)
            if ref is None:
                # MCP tools are presented as <server>__<tool>; the policy is on the server ref.
                tool = next((t for t in ctx.tools if t.name == call.name), None)
                server = tool.options.get("mcp_server") if tool else None
                ref = ctx.spec.tool(server) if server else None
            policy = parse_approval(ref.approval if ref else "never")
            try:
                needed = policy.requires_approval(call.name, call.arguments)
            except Exception:  # a broken expression fails safe
                needed = True
            if not needed:
                continue
            decision = await self.steps.get(ctx.run_id, f"approval:{call.id}")
            if decision is not None and decision.status == "completed" and decision.output:
                if not decision.output.get("approved"):
                    reason = decision.output.get("reason") or "no reason given"
                    results[call.id] = ToolResultBlock(
                        call_id=call.id,
                        content=f"The user denied this tool call: {reason}",
                        is_error=True,
                        native_name=call.native_name,
                    )
                continue
            request = {"call_id": call.id, "name": call.name, "arguments": call.arguments}
            pending.append(request)
            if decision is None:
                await self.steps.begin(
                    StepSpec(
                        session_id=ctx.session_id, run_id=ctx.run_id, key=f"approval:{call.id}", type="approval", input=request
                    )
                )
                await self._emit(ctx, "tool.approval.requested", request)
        return pending

    async def _tool_step(self, ctx: RunContext, call: ToolCallBlock) -> ToolResultBlock:
        key = f"tool:{call.id}"
        done = await self.steps.get(ctx.run_id, key)
        if done is not None and done.status == "completed" and done.output:
            return ToolResultBlock.model_validate(done.output["result"])
        sid = await self.steps.begin(
            StepSpec(
                session_id=ctx.session_id,
                run_id=ctx.run_id,
                key=key,
                type="tool",
                input={"name": call.name, "arguments": call.arguments},
            )
        )
        cctx = CallContext(session_id=ctx.session_id, run_id=ctx.run_id, call_id=call.id, idempotency_key=f"{ctx.run_id}:{key}")
        with tracing.span(f"execute_tool {call.name}", tracing.tool_attributes(name=call.name, call_id=call.id, extra=ctx.attributes)) as sp:
            try:
                result = await ctx.executor.execute(call, cctx)
            except Exception as exc:  # executor bugs become failed results, not crashed runs
                result = ToolResultBlock(call_id=call.id, content=f"Tool failed: {exc}", is_error=True, native_name=call.native_name)
            sp.set_attribute("agents.tool.is_error", result.is_error)
        await self.steps.complete(sid, {"result": result.model_dump(mode="json")})
        await self._emit(
            ctx, "tool.result", {"id": call.id, "name": call.name, "content": result.content, "is_error": result.is_error}
        )
        return result

    async def _maybe_compact(self, ctx: RunContext, builder: TranscriptBuilder, step: int, system: str) -> None:
        key = f"compact:{step}"
        done = await self.steps.get(ctx.run_id, key)
        if done is not None and done.status == "completed":
            builder.add(done)
            return
        if step == 0:
            return
        spec = ctx.spec
        adapter, name = self.adapters.resolve(spec.models[0])
        manifest = adapter.capabilities(name)
        if manifest.native_compaction and spec.model_options.get(adapter.id, {}).get("compaction"):
            return
        threshold = spec.limits.compact_at_tokens or int((manifest.context_window or 200_000) * 0.75)
        messages = builder.build()
        if estimate_tokens(system, messages) < threshold:
            return
        sid = await self.steps.begin(StepSpec(session_id=ctx.session_id, run_id=ctx.run_id, key=key, type="compaction"))
        request = [*messages, Message.user(COMPACTION_PROMPT)]
        response = await self._call_models(ctx, _merge_users(request), system)
        summary = response.message.text or "(no summary)"
        compacted = [Message(role="user", content=[TextBlock(text=f"<summary of earlier conversation>\n{summary}\n</summary>\n\nContinue the task.")])]
        await self.steps.complete(sid, {"messages": [m.model_dump(mode="json") for m in compacted], "usage": response.usage.model_dump()})
        done = await self.steps.get(ctx.run_id, key)
        assert done is not None
        builder.add(done)


def _completed(type_: str, ctx: RunContext, output: dict[str, Any]) -> Any:
    from ..store.base import Step

    return Step(id="", seq=0, session_id=ctx.session_id, run_id=ctx.run_id, key="", type=type_, status="completed", output=output)  # type: ignore[arg-type]


def _merge_users(messages: list[Message]) -> list[Message]:
    b = TranscriptBuilder()
    for m in messages:
        b.append(m)
    return b.build()


def estimate_tokens(system: str, messages: list[Message]) -> int:
    """A cheap estimate (about 4 characters per token) used to trigger compaction."""
    size = len(system) + sum(len(json.dumps(m.model_dump(mode="json"))) for m in messages)
    return size // 4
