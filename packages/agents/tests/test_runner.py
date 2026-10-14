from __future__ import annotations

import asyncio

import pytest
from agents import Agent, tool
from agents.adapters.base import ModelError
from agents.events import new_id
from agents.runtime.local import LocalRuntime
from agents.runtime.runner import RunContext, Runner
from agents.runtime.toolset import tool_specs
from agents.sandbox import Sandbox
from agents.store.memory import InMemoryEventLog, InMemoryStepStore
from agents.testing import ScriptedAdapter, call, calls, scripted_registry, text
from agents.tools.executor import ToolExecutor
from agents.types import Message, ModelResponse, TextBlock, ToolCallBlock, Usage


async def run_agent(agent: Agent, adapter: ScriptedAdapter, prompt: str = "go", **kw):
    runtime = LocalRuntime(adapters=scripted_registry(adapter))
    sid = await runtime.create_session(agent.spec(), functions=agent.functions, skills=agent.skills, sandbox=kw.get("sandbox"), agents=agent.agents)
    await runtime.send(sid, prompt)
    result = await runtime.wait(sid)
    events = await runtime.events.read(sid)
    return runtime, sid, result, events


async def test_plain_text_turn():
    adapter = ScriptedAdapter([text("hello there")])
    agent = Agent("greeter", "scripted", "Be nice.")
    _, _, result, events = await run_agent(agent, adapter)
    assert result.stop_reason == "end_turn"
    assert result.output == "hello there"
    types = [e.type for e in events]
    assert types[:3] == ["session.status", "session.status", "run.started"]
    assert "message.agent.delta" in types and types[-2] == "run.finished" and types[-1] == "session.status"
    assert [e.seq for e in events] == list(range(1, len(events) + 1))
    assert adapter.requests[0].system == "Be nice."
    assert adapter.requests[0].messages[0].text == "go"


async def test_tool_loop_runs_in_sandbox_and_groups_parallel_results():
    adapter = ScriptedAdapter(
        [
            calls(
                [
                    ("files", {"command": "create", "path": "/workspace/outputs/a.txt", "file_text": "alpha\n"}),
                    ("shell", {"command": "echo hi"}),
                ],
                ids=["c1", "c2"],
            ),
            call("files", {"command": "view", "path": "/workspace/outputs/a.txt"}, id="c3"),
            text("done"),
        ]
    )
    agent = Agent("worker", "scripted", tools=["shell", "files"])
    runtime, sid, result, _ = await run_agent(agent, adapter, sandbox=Sandbox.local())
    assert result.output == "done"
    second = adapter.requests[1].messages
    results = second[-1].content
    assert [b.call_id for b in results] == ["c1", "c2"]  # same order as the calls
    assert "hi" in results[1].content and "[exit code 0]" in results[1].content
    third = adapter.requests[2].messages[-1].content[0]
    assert "alpha" in third.content and third.content.strip().startswith("1")
    outputs = await runtime.read_outputs(sid)
    assert [f.path for f in outputs] == ["/workspace/outputs/a.txt"]
    await runtime.close(sid)


async def test_function_tool_validation_and_unknown_tool():
    seen = []

    @tool
    def add(a: int, b: int) -> int:
        """Add two numbers."""
        seen.append((a, b))
        return a + b

    adapter = ScriptedAdapter(
        [
            calls([("add", {"a": "x"}), ("nope", {})], ids=["c1", "c2"]),
            call("add", {"a": 2, "b": 3}, id="c3"),
            text("5"),
        ]
    )
    agent = Agent("calc", "scripted", tools=[add])
    _, _, result, _ = await run_agent(agent, adapter)
    bad, unknown = adapter.requests[1].messages[-1].content
    assert bad.is_error and "Invalid arguments" in bad.content
    assert unknown.is_error and "Unknown tool" in unknown.content
    assert adapter.requests[2].messages[-1].content[0].content == "5"
    assert seen == [(2, 3)]
    assert result.output == "5"


async def test_parse_error_becomes_error_result():
    bad = ModelResponse(
        message=Message(role="assistant", content=[ToolCallBlock(id="c1", name="shell", arguments={}, parse_error="INVALID_JSON: x")]),
        stop_reason="tool_use",
        model="scripted",
    )
    adapter = ScriptedAdapter([bad, text("ok")])
    agent = Agent("a", "scripted", tools=["shell"])
    await run_agent(agent, adapter, sandbox=Sandbox.local())
    res = adapter.requests[1].messages[-1].content[0]
    assert res.is_error and res.content.startswith("INVALID_JSON")


async def test_approval_pause_approve_and_resume():
    ran = []

    @tool(approval={"when": "args.amount > 100"})
    def pay(amount: int) -> str:
        """Pay."""
        ran.append(amount)
        return f"paid {amount}"

    adapter = ScriptedAdapter(
        [calls([("pay", {"amount": 5}), ("pay", {"amount": 500})], ids=["small", "big"]), text("all paid")]
    )
    agent = Agent("payer", "scripted", tools=[pay])
    runtime, sid, result, events = await run_agent(agent, adapter)
    assert result.stop_reason == "approval_pending"
    assert [p["call_id"] for p in result.pending_approvals] == ["big"]
    assert ran == []  # nothing runs while a call in the turn awaits approval
    assert runtime.sessions[sid].status == "approval_pending"
    assert any(e.type == "tool.approval.requested" for e in events)

    await runtime.approve(sid, "big", True)
    result = await runtime.wait(sid)
    assert result.stop_reason == "end_turn" and result.output == "all paid"
    assert sorted(ran) == [5, 500]
    assert len(adapter.requests) == 2  # the first model call was not repeated
    types = [e.type for e in await runtime.events.read(sid)]
    assert types.count("run.started") == 1 and "tool.approval.decided" in types


async def test_denied_call_returns_error_result():
    @tool(approval="always")
    def deploy(service: str) -> str:
        """Deploy."""
        raise AssertionError("must not run")

    adapter = ScriptedAdapter([call("deploy", {"service": "api"}, id="d1"), text("ok, not deploying")])
    agent = Agent("deployer", "scripted", tools=[deploy])
    runtime, sid, result, _ = await run_agent(agent, adapter)
    assert result.stop_reason == "approval_pending"
    await runtime.approve(sid, "d1", False, "not today")
    result = await runtime.wait(sid)
    res = adapter.requests[1].messages[-1].content[0]
    assert res.is_error and "not today" in res.content
    assert result.output == "ok, not deploying"


async def test_model_fallback_on_error_and_refusal():
    primary = ScriptedAdapter([ModelError("rate_limit", "429", status=429)])
    second = ScriptedAdapter(
        [
            ModelResponse(
                message=Message(role="assistant", content=[]), stop_reason="refusal", model="scripted-1", refusal_category="cyber"
            )
        ]
    )
    third = ScriptedAdapter([text("from third")])
    agent = Agent("fb", ["scripted", "scripted-1", "scripted-2"])
    runtime = LocalRuntime(adapters=scripted_registry(primary, second, third))
    sid = await runtime.create_session(agent.spec())
    await runtime.send(sid, "hi")
    result = await runtime.wait(sid)
    assert result.output == "from third"
    assert result.model == "scripted-2"
    fallbacks = [e.payload for e in await runtime.events.read(sid) if e.type == "error"]
    assert [(f["from"], f["to"]) for f in fallbacks] == [("scripted", "scripted-1"), ("scripted-1", "scripted-2")]


async def test_bad_request_does_not_fall_back():
    primary = ScriptedAdapter([ModelError("bad_request", "400")])
    second = ScriptedAdapter([text("never")])
    agent = Agent("fb", ["scripted", "scripted-1"])
    runtime = LocalRuntime(adapters=scripted_registry(primary, second))
    sid = await runtime.create_session(agent.spec())
    await runtime.send(sid, "hi")
    result = await runtime.wait(sid)
    assert result.stop_reason == "error" and second.requests == []
    assert runtime.sessions[sid].status == "failed"


async def test_max_steps_budget():
    adapter = ScriptedAdapter([call("shell", {"command": "true"}) for _ in range(3)])
    agent = Agent("loop", "scripted", tools=["shell"], limits={"max_steps": 2})
    _, _, result, _ = await run_agent(agent, adapter, sandbox=Sandbox.local())
    assert result.stop_reason == "budget" and "max_steps" in result.error


async def test_token_budget():
    adapter = ScriptedAdapter([call("shell", {"command": "true"}) for _ in range(3)])
    agent = Agent("loop", "scripted", tools=["shell"], limits={"max_tokens": 20})
    _, _, result, _ = await run_agent(agent, adapter, sandbox=Sandbox.local())
    assert result.stop_reason == "budget" and result.usage.input_tokens + result.usage.output_tokens > 20


async def test_steering_is_injected_at_next_boundary():
    gate = asyncio.Event()

    @tool
    async def wait_a_bit() -> str:
        """Wait."""
        await gate.wait()
        return "waited"

    adapter = ScriptedAdapter([call("wait_a_bit", {}, id="w"), text("ok")])
    agent = Agent("steer", "scripted", tools=[wait_a_bit])
    runtime = LocalRuntime(adapters=scripted_registry(adapter))
    sid = await runtime.create_session(agent.spec(), functions=agent.functions)
    await runtime.send(sid, "start")
    await asyncio.sleep(0.05)
    await runtime.send(sid, "also check the logs")
    gate.set()
    await runtime.wait(sid)
    last = adapter.requests[1].messages[-1]
    assert [b.type for b in last.content] == ["tool_result", "text"]
    assert last.content[1].text == "also check the logs"


async def test_interrupt_cancels_run():
    @tool
    async def hang() -> str:
        """Hang."""
        await asyncio.sleep(30)
        return "never"

    adapter = ScriptedAdapter([call("hang", {})])
    agent = Agent("hang", "scripted", tools=[hang])
    runtime = LocalRuntime(adapters=scripted_registry(adapter))
    sid = await runtime.create_session(agent.spec(), functions=agent.functions)
    await runtime.send(sid, "go")
    await asyncio.sleep(0.05)
    await runtime.interrupt(sid)
    result = await runtime.wait(sid)
    assert result.stop_reason == "interrupted"
    events = await runtime.events.read(sid)
    finished = [e for e in events if e.type == "run.finished"]
    assert finished and finished[-1].payload["stop_reason"] == "interrupted"
    assert runtime.sessions[sid].status == "idle"


async def test_follow_up_run_sees_previous_transcript():
    adapter = ScriptedAdapter([text("first answer"), text("second answer")])
    agent = Agent("chat", "scripted")
    runtime = LocalRuntime(adapters=scripted_registry(adapter))
    sid = await runtime.create_session(agent.spec())
    await runtime.send(sid, "q1")
    await runtime.wait(sid)
    await runtime.send(sid, "q2")
    result = await runtime.wait(sid)
    assert result.output == "second answer"
    msgs = adapter.requests[1].messages
    assert [m.role for m in msgs] == ["user", "assistant", "user"]
    assert msgs[1].text == "first answer"


async def test_compaction_replaces_transcript_with_summary():
    big = "x" * 4000
    adapter = ScriptedAdapter(
        [call("echo", {"s": big}, id="c1"), text("SUMMARY: echoed a big string"), text("finished")]
    )

    @tool
    def echo(s: str) -> str:
        """Echo."""
        return s

    agent = Agent("compact", "scripted", tools=[echo], limits={"compact_at_tokens": 500})
    _, _, result, _ = await run_agent(agent, adapter)
    assert result.output == "finished"
    summary_req = adapter.requests[1]
    assert "summary" in summary_req.messages[-1].content[-1].text.lower()
    after = adapter.requests[2].messages
    assert len(after) == 1 and "SUMMARY: echoed" in after[0].text


async def test_crash_resume_never_repeats_completed_tool_calls():
    """A worker dies after a tool step completed; another worker resumes the run."""
    executions = []

    @tool
    def side_effect(n: int) -> str:
        """Do something with a side effect."""
        executions.append(n)
        return f"did {n}"

    class Crash(Exception):
        pass

    def crash(_req):
        raise Crash("worker died")

    agent = Agent("durable", "scripted", tools=[side_effect])
    spec = agent.spec()
    steps, events = InMemoryStepStore(), InMemoryEventLog()
    session_id, run_id = new_id("ses"), new_id("run")

    def ctx() -> RunContext:
        specs = {t.name: t for t in tool_specs(spec)}
        return RunContext(
            session_id=session_id,
            run_id=run_id,
            spec=spec,
            executor=ToolExecutor(specs, functions=agent.functions),
            tools=tool_specs(spec),
            inputs=[Message.user("do two things")],
        )

    first = ScriptedAdapter([call("side_effect", {"n": 1}, id="a"), crash])
    with pytest.raises(Crash):
        await Runner(scripted_registry(first), steps, events).run(ctx())
    assert executions == [1]

    second = ScriptedAdapter([call("side_effect", {"n": 2}, id="b"), text("both done")])
    result = await Runner(scripted_registry(second), steps, events).run(ctx())
    assert result.stop_reason == "end_turn" and result.output == "both done"
    assert executions == [1, 2]  # the completed call was replayed, not repeated
    assert len(second.requests) == 2
    replayed = second.requests[0].messages
    assert replayed[-1].content[0].call_id == "a" and replayed[-1].content[0].content == "did 1"
    types = [e.type for e in await events.read(session_id)]
    assert types.count("run.started") == 1 and types.count("message.user") == 1


async def test_tool_step_begun_but_not_completed_is_retried_with_same_key():
    keys = []

    class Recorder(ToolExecutor):
        async def execute(self, call, cctx):
            keys.append(cctx.idempotency_key)
            if len(keys) == 1:
                raise asyncio.CancelledError  # the worker is killed mid-call
            return await super().execute(call, cctx)

    @tool
    def charge(cents: int) -> str:
        """Charge."""
        return "charged"

    agent = Agent("pay", "scripted", tools=[charge])
    spec = agent.spec()
    steps, events = InMemoryStepStore(), InMemoryEventLog()

    def ctx() -> RunContext:
        return RunContext(
            session_id="ses_x",
            run_id="run_x",
            spec=spec,
            executor=Recorder({t.name: t for t in tool_specs(spec)}, functions=agent.functions),
            tools=tool_specs(spec),
            inputs=[Message.user("charge it")],
        )

    with pytest.raises(asyncio.CancelledError):
        await Runner(scripted_registry(ScriptedAdapter([call("charge", {"cents": 5}, id="k")])), steps, events).run(ctx())
    await Runner(scripted_registry(ScriptedAdapter([text("ok")])), steps, events).run(ctx())
    assert keys == ["run_x:tool:k", "run_x:tool:k"]
    step = await steps.get("run_x", "tool:k")
    assert step.attempts == 2 and step.status == "completed"


async def test_pause_turn_continues():
    paused = ModelResponse(
        message=Message(role="assistant", content=[TextBlock(text="searching")]), stop_reason="pause_turn", model="scripted", usage=Usage()
    )
    adapter = ScriptedAdapter([paused, text("found it")])
    _, _, result, _ = await run_agent(Agent("p", "scripted"), adapter)
    assert result.output == "found it" and len(adapter.requests) == 2


async def test_spawn_subagent_returns_child_answer():
    adapter = ScriptedAdapter(
        [
            call("spawn_subagent", {"task": "research X"}, id="s1"),
            text("child says X is 42"),  # the child's turn
            text("X is 42"),
        ]
    )
    agent = Agent("parent", "scripted", subagents={"max_concurrent": 2})
    runtime, sid, result, events = await run_agent(agent, adapter)
    assert result.output == "X is 42"
    tool_result = adapter.requests[2].messages[-1].content[0]
    assert tool_result.content == "child says X is 42"
    assert adapter.requests[1].messages[0].text == "research X"
    assert {"subagent.started", "subagent.finished"} <= {e.type for e in events}


async def test_call_agent_tool_delegates_to_local_agent():
    adapter = ScriptedAdapter([call("call_helper", {"input": "summarize"}, id="h"), text("helper output"), text("final")])
    helper = Agent("helper", "scripted", "You summarize.")
    boss = Agent("boss", "scripted", tools=[helper])
    _, _, result, _ = await run_agent(boss, adapter)
    assert result.output == "final"
    assert adapter.requests[1].system == "You summarize."
    assert adapter.requests[2].messages[-1].content[0].content == "helper output"
