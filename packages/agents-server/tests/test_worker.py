from __future__ import annotations

import asyncio
import base64
import os

import pytest

from agents import Agent
from agents.adapters import AdapterRegistry
from agents.sandbox.local import LocalSandboxProvider
from agents.testing import ScriptedAdapter, call, text
from agents_server.auth import bootstrap
from agents_server.blobs import FileBlobStore
from agents_server.config import Settings
from agents_server.service import Conflict
from agents_server.services import Services


class Harness:
    def __init__(self, services: Services, adapter: ScriptedAdapter, project: str) -> None:
        self.services = services
        self.platform = services.platform
        self.adapter = adapter
        self.project = project
        self.sandboxes = LocalSandboxProvider()

    def worker(self, worker_id: str = "w1"):
        return self.services.worker(worker_id=worker_id, sandboxes=lambda env: self.sandboxes)

    async def register(self, agent: Agent, alias: str = "prod") -> int:
        row, _ = await self.platform.registry.register(self.project, agent.spec(), "key:test")
        await self.platform.registry.set_alias(self.project, agent.name, alias, {"versions": [{"version": row["version"], "weight": 100}]}, "key:test")
        self.platform.router.cache.invalidate()
        return row["version"]

    async def events(self, session_id: str):
        return await self.platform.events.read(session_id)

    async def run(self, session_id: str):
        return dict(await self.services.pool.fetchrow("SELECT * FROM runs WHERE session_id = $1 ORDER BY enqueued_at DESC LIMIT 1", session_id))


@pytest.fixture
async def h(pool, dsn, tmp_path):
    adapter = ScriptedAdapter([])
    adapters = AdapterRegistry()
    adapters.register("scripted", adapter)
    settings = Settings(
        database_url=dsn,
        master_key=base64.b64encode(os.urandom(32)).decode(),
        blob_url=f"file://{tmp_path}/blobs",
        sandbox_provider="local",
        lease_seconds=2,
    )
    services = await Services.start(settings, pool=pool, adapters=adapters, blobs=FileBlobStore(str(tmp_path / "blobs")), run_migrations=False)
    project = await bootstrap(pool, "ak_test_admin")
    yield Harness(services, adapter, project)
    if services.hub:
        await services.hub.stop()


async def test_invoke_runs_on_a_worker(h):
    await h.register(Agent("bot", "scripted", "Be brief.", tools=["shell"]))
    h.adapter.turns += [call("shell", {"command": "echo hosted > /workspace/outputs/out.txt && echo ok"}, id="c1"), text("done")]
    inv = await h.platform.invoke(h.project, "bot@prod", "go", actor="key:test")
    assert inv.route.version == 1
    assert await h.worker().run_once()
    session = await h.platform.session(h.project, inv.session_id)
    assert session["status"] == "idle" and session["sandbox_state"] == "running"
    run = await h.run(inv.session_id)
    assert run["status"] == "finished" and run["stop_reason"] == "end_turn" and run["output"] == "done"
    types = [e.type for e in await h.events(inv.session_id)]
    assert types[:2] == ["route.resolved", "session.status"]
    assert {"run.started", "tool.call", "tool.result", "artifact.created", "run.finished"} <= set(types)
    usage = await h.services.pool.fetchrow("SELECT * FROM usage_records WHERE run_id = $1", inv.run_id)
    assert usage["input_tokens"] == 20 and usage["tool_calls"] == 1
    arts = await h.platform.list_artifacts(h.project, inv.session_id)
    assert [a["path"] for a in arts] == ["out.txt"]
    _, data = await h.platform.artifact(h.project, inv.session_id, arts[0]["id"])
    assert data == b"hosted\n"


async def test_follow_up_input_reuses_session_and_transcript(h):
    await h.register(Agent("chat", "scripted"))
    h.adapter.turns += [text("one"), text("two")]
    inv = await h.platform.invoke(h.project, "chat", "first", actor="key:test")
    await h.worker().run_once()
    res = await h.platform.send_input(h.project, inv.session_id, "second", "key:test")
    assert res["steered"] is False
    await h.worker().run_once()
    assert [m.role for m in h.adapter.requests[-1].messages] == ["user", "assistant", "user"]
    assert (await h.run(inv.session_id))["output"] == "two"


async def test_approval_waits_then_resumes_on_any_worker(h):
    await h.register(Agent("ops", "scripted", tools=[{"builtin": "shell", "approval": "always"}]))
    h.adapter.turns += [call("shell", {"command": "echo deploying"}, id="d1"), text("deployed")]
    inv = await h.platform.invoke(h.project, "ops", "deploy", actor="key:test")
    await h.worker("w1").run_once()
    run = await h.run(inv.session_id)
    assert run["status"] == "waiting" and run["stop_reason"] == "approval_pending"
    assert (await h.platform.session(h.project, inv.session_id))["status"] == "approval_pending"
    assert not await h.worker("w2").run_once()  # nothing runnable while waiting
    with pytest.raises(Conflict):
        await h.platform.send_input(h.project, inv.session_id, "hello?", "key:test")
    res = await h.platform.decide_approval(h.project, inv.session_id, "d1", True, None, "key:test")
    assert res["resumed"]
    assert await h.worker("w2").run_once()
    run = await h.run(inv.session_id)
    assert run["status"] == "finished" and run["output"] == "deployed"
    assert len(h.adapter.requests) == 2
    result = h.adapter.requests[1].messages[-1].content[0]
    assert "deploying" in result.content


async def test_worker_killed_mid_run_is_resumed_by_another(h):
    """The chaos test: kill a worker mid-run; the session resumes without repeating work."""
    await h.register(Agent("durable", "scripted", tools=["shell"]))
    marker = "/workspace/count.txt"
    h.adapter.turns += [
        call("shell", {"command": f"echo x >> {marker}"}, id="t1"),
        # The worker dies during this call; on retry the marker file makes it quick.
        call("shell", {"command": "if [ -f /workspace/go ]; then echo fast; else sleep 30; fi"}, id="t2"),
    ]
    inv = await h.platform.invoke(h.project, "durable", "go", actor="key:test")
    w1 = h.worker("w1")
    task = asyncio.create_task(w1.run_once())
    for _ in range(100):
        if await h.services.pool.fetchval("SELECT 1 FROM steps WHERE run_id = $1 AND key = 'tool:t2'", inv.run_id):
            break
        await asyncio.sleep(0.05)
    task.cancel()  # the process dies: no finish, the lease is left to expire
    with pytest.raises(asyncio.CancelledError):
        await task
    assert (await h.run(inv.session_id))["status"] == "running"
    assert not await h.worker("w2").run_once()  # lease still held
    await h.services.pool.execute("UPDATE runs SET lease_until = now() - interval '1 second' WHERE id = $1", inv.run_id)
    h.adapter.turns[:] = [text("recovered")]
    session = await h.platform.session(h.project, inv.session_id)
    sandbox_dir = session["sandbox"]["data"]["dir"]
    open(f"{sandbox_dir}/go", "w").close()

    assert await h.worker("w2").run_once()
    run = await h.run(inv.session_id)
    assert run["status"] == "finished" and run["output"] == "recovered" and run["attempts"] == 2
    with open(f"{sandbox_dir}/count.txt") as f:
        assert f.read() == "x\n"  # t1 ran exactly once
    steps = await h.services.pool.fetch("SELECT key, attempts FROM steps WHERE run_id = $1 ORDER BY seq", inv.run_id)
    assert {r["key"]: r["attempts"] for r in steps}["tool:t2"] == 2
    assert "fast" in h.adapter.requests[-1].messages[-1].content[0].content
    statuses = [e.payload for e in await h.events(inv.session_id) if e.type == "session.status"]
    assert any(p.get("resumed") for p in statuses)


async def test_call_agent_runs_child_inline(h):
    await h.register(Agent("helper", "scripted", "You help."))
    await h.register(Agent("boss", "scripted", tools=[{"agent": "helper@prod"}]))
    h.adapter.turns += [call("call_helper", {"input": "summarize"}, id="c"), text("helper says hi"), text("final")]
    inv = await h.platform.invoke(h.project, "boss", "go", actor="key:test")
    await h.worker().run_once()
    assert (await h.run(inv.session_id))["output"] == "final"
    child = await h.services.pool.fetchrow("SELECT * FROM sessions WHERE parent_session_id = $1", inv.session_id)
    assert child["agent"] == "helper" and child["depth"] == 1
    assert h.adapter.requests[1].system == "You help."
    types = [e.type for e in await h.events(inv.session_id)]
    assert "subagent.started" in types and "subagent.finished" in types


async def test_spawn_subagent_shares_sandbox_with_reduced_tools(h):
    await h.register(Agent("lead", "scripted", tools=["shell", "files"], subagents={"max_concurrent": 2}))
    h.adapter.turns += [
        call("spawn_subagent", {"task": "write a file", "tools": ["shell"]}, id="s"),
        call("shell", {"command": "echo from-child > /workspace/child.txt"}, id="cs"),
        text("child done"),
        call("shell", {"command": "cat /workspace/child.txt"}, id="read"),
        text("lead done"),
    ]
    inv = await h.platform.invoke(h.project, "lead", "go", actor="key:test")
    await h.worker().run_once()
    assert (await h.run(inv.session_id))["output"] == "lead done"
    child_tools = [t.name for t in h.adapter.requests[1].tools]
    assert child_tools == ["shell", "spawn_subagent"]
    assert h.adapter.requests[3].messages[-1].content[0].content == "child done"
    assert "from-child" in h.adapter.requests[4].messages[-1].content[0].content


async def test_memory_persists_across_sessions(h):
    await h.register(Agent("mem", "scripted", tools=["shell"]))
    h.adapter.turns += [
        call("shell", {"command": "echo 'user likes tea' > /workspace/memory/prefs.md"}, id="m1"),
        text("noted"),
        call("shell", {"command": "cat /workspace/memory/prefs.md"}, id="m2"),
        text("remembered"),
    ]
    a = await h.platform.invoke(h.project, "mem", "remember", actor="key:test")
    await h.worker().run_once()
    b = await h.platform.invoke(h.project, "mem", "recall", actor="key:test")
    await h.worker().run_once()
    assert a.session_id != b.session_id
    assert "user likes tea" in h.adapter.requests[3].messages[-1].content[0].content


async def test_interrupt_cancels_running_run(h):
    await h.register(Agent("slow", "scripted", tools=["shell"]))
    h.adapter.turns += [call("shell", {"command": "sleep 30"}, id="z")]
    inv = await h.platform.invoke(h.project, "slow", "go", actor="key:test")
    task = asyncio.create_task(h.worker().run_once())
    for _ in range(100):
        if await h.services.pool.fetchval("SELECT 1 FROM steps WHERE run_id = $1 AND key = 'tool:z'", inv.run_id):
            break
        await asyncio.sleep(0.05)
    await h.platform.interrupt(h.project, inv.session_id, "key:test")
    await asyncio.wait_for(task, 10)
    run = await h.run(inv.session_id)
    assert run["status"] == "cancelled" and run["stop_reason"] == "interrupted"
    assert (await h.platform.session(h.project, inv.session_id))["status"] == "idle"


async def test_budget_and_policy_checks(h):
    await h.register(Agent("bot", "scripted"))
    await h.platform.set_policy(h.project, {"allowed_agents": ["other"]}, "key:test")
    with pytest.raises(PermissionError):
        await h.platform.invoke(h.project, "bot", "go", actor="key:test")
    await h.platform.set_policy(h.project, {"budget": {"max_tokens": 10}}, "key:test")
    h.adapter.turns += [text("spent")]
    await h.platform.invoke(h.project, "bot", "go", actor="key:test")
    await h.worker().run_once()
    with pytest.raises(PermissionError):
        await h.platform.invoke(h.project, "bot", "again", actor="key:test")


async def test_secrets_are_encrypted_and_audited(h):
    secrets = h.platform.secrets
    assert await secrets.put(h.project, "OBS_TOKEN", "s3cret", "key:test") == 1
    assert await secrets.put(h.project, "OBS_TOKEN", "s3cret2", "key:test") == 2
    raw = await h.services.pool.fetchrow("SELECT * FROM secrets WHERE name = 'OBS_TOKEN'")
    assert b"s3cret" not in bytes(raw["ciphertext"])
    assert await secrets.get(h.project, "OBS_TOKEN", actor="worker:w1", reason="tool obs") == "s3cret2"
    actions = [r["action"] for r in await h.services.pool.fetch("SELECT action FROM audit_log WHERE target = 'OBS_TOKEN' ORDER BY id")]
    assert actions == ["secret.write", "secret.write", "secret.read"]
    assert [s["name"] for s in await secrets.list(h.project)] == ["OBS_TOKEN"]


async def test_resumed_parent_reuses_its_child_session(h):
    """A parent that dies while its child runs must not start a second child on resume."""
    await h.register(Agent("helper", "scripted", tools=["shell"]))
    await h.register(Agent("boss", "scripted", tools=[{"agent": "helper@prod"}]))
    h.adapter.turns += [
        call("call_helper", {"input": "work"}, id="c"),
        call("shell", {"command": "if [ -f /workspace/go ]; then echo fast; else sleep 30; fi"}, id="slow"),
    ]
    inv = await h.platform.invoke(h.project, "boss", "go", actor="key:test")
    task = asyncio.create_task(h.worker("w1").run_once())
    for _ in range(100):
        if await h.services.pool.fetchval("SELECT 1 FROM steps WHERE key = 'tool:slow'"):
            break
        await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    child = await h.services.pool.fetchrow("SELECT * FROM sessions WHERE parent_session_id = $1", inv.session_id)
    open(f"{child['sandbox']['data']['dir']}/go", "w").close()
    await h.services.pool.execute("UPDATE runs SET lease_until = now() - interval '1 second'")
    h.adapter.turns[:] = [text("child finished"), text("boss finished")]
    assert await h.worker("w2").run_once()
    assert (await h.run(inv.session_id))["output"] == "boss finished"
    children = await h.services.pool.fetch("SELECT id FROM sessions WHERE parent_session_id = $1", inv.session_id)
    assert [c["id"] for c in children] == [child["id"]]
