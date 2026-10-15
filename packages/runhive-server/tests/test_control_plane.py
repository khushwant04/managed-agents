from __future__ import annotations

from collections import Counter

import pytest

from runhive import Agent
from runhive.adapters import AdapterRegistry
from runhive.events import Event
from runhive.store.base import StepSpec
from runhive.testing import ScriptedAdapter
from runhive.types import Message
from runhive_server.auth import authenticate, bootstrap, create_key
from runhive_server.db import migrate
from runhive_server.queue import RunQueue
from runhive_server.registry import Registry, RegistryError
from runhive_server.router import RouteError, Router, bucket, parse_target
from runhive_server.stores import PostgresEventLog, PostgresSteeringQueue, PostgresStepStore


@pytest.fixture
async def project(pool) -> str:
    return await bootstrap(pool, "ak_test_admin")


@pytest.fixture
def registry(pool) -> Registry:
    reg = AdapterRegistry()
    reg.register("scripted", ScriptedAdapter([]))
    return Registry(pool, reg)


async def make_session(pool, project: str, sid: str = "ses_1", agent: str = "bot") -> str:
    await pool.execute(
        "INSERT INTO sessions (id, project_id, agent, version) VALUES ($1, $2, $3, 1)", sid, project, agent
    )
    return sid


async def test_migrations_are_idempotent(pool):
    assert await migrate(pool) == []


async def test_api_keys_and_roles(pool, project):
    p = await authenticate(pool, "ak_test_admin")
    assert p and p.project_id == project and p.role == "admin" and p.can("developer")
    _, key = await create_key(pool, project, "ci", "viewer")
    viewer = await authenticate(pool, key)
    assert viewer and viewer.role == "viewer" and not viewer.can("developer")
    assert await authenticate(pool, "ak_nope_nope") is None
    stored = await pool.fetchval("SELECT hash FROM api_keys WHERE id = $1", viewer.key_id)
    assert key not in stored


async def test_register_is_content_hashed_and_versioned(pool, project, registry):
    spec = Agent("bot", "scripted", "v1").spec()
    v1, created = await registry.register(project, spec, "key:a")
    assert created and v1["version"] == 1 and v1["card"]["name"] == "bot"
    again, created = await registry.register(project, spec, "key:a")
    assert not created and again["version"] == 1
    v2, created = await registry.register(project, Agent("bot", "scripted", "v2").spec(), "key:a")
    assert created and v2["version"] == 2
    assert [v["version"] for v in await registry.list_versions(project, "bot")] == [2, 1]
    actions = [r["action"] for r in await pool.fetch("SELECT action FROM audit_log ORDER BY id")]
    assert actions == ["agent.register", "agent.register"]


async def test_register_rejects_what_models_cannot_serve(pool, project, registry):
    with pytest.raises(RegistryError) as info:
        await registry.register(
            project,
            {
                "name": "bad",
                "models": ["mystery-model", "scripted"],
                "reasoning": "high",
                "tools": [{"type": "function", "name": "f"}, {"type": "agent", "name": "call_x", "options": {"agent": "x@prod"}}],
                "skills": [{"name": "runbooks"}],
            },
            "key:a",
        )
    problems = " | ".join(info.value.problems)
    assert "mystery-model" in problems
    assert "cannot serve: reasoning" in problems
    assert "needs a webhook url" in problems
    assert "unknown agent 'x'" in problems
    assert "skill 'runbooks' has no version" in problems
    with pytest.raises(RegistryError):
        await registry.register(project, {"name": "Bad Name", "models": ["scripted"]}, "key:a")


async def test_project_policy_allowlists(pool, project, registry):
    spec = Agent("bot", "scripted", tools=["shell"]).spec()
    with pytest.raises(RegistryError) as info:
        await registry.register(project, spec, "key:a", {"allowed_models": ["claude-opus-5-5"], "allowed_tools": ["files"]})
    assert len(info.value.problems) == 2


async def test_aliases_splits_and_router(pool, project, registry):
    for i in range(3):
        await registry.register(project, Agent("bot", "scripted", f"v{i}").spec(), "key:a")
    await registry.set_alias(project, "bot", "prod", {"versions": [{"version": 2, "weight": 100}]}, "key:a")
    router = Router(registry)
    assert (await router.resolve(project, "bot@prod", "ses_x")).version == 2
    assert (await router.resolve(project, "bot", "ses_x")).version == 2  # bare name means @prod
    assert (await router.resolve(project, "bot@1", "ses_x")).version == 1
    assert (await router.resolve(project, "bot@latest", "ses_x")).version == 3
    with pytest.raises(RouteError):
        await router.resolve(project, "bot@canary", "ses_x")
    with pytest.raises(RouteError):
        await router.resolve(project, "bot@9", "ses_x")

    await registry.set_alias(project, "bot", "prod", {"versions": [{"version": 2, "weight": 90}, {"version": 3, "weight": 10}]}, "key:a")
    router.cache.invalidate(f"{project}:bot:prod")
    picks = Counter([(await router.resolve(project, "bot@prod", f"ses_{i}")).version for i in range(2000)])
    assert 120 <= picks[3] <= 280 and picks[2] + picks[3] == 2000
    sticky = {(await router.resolve(project, "bot@prod", "ses_same")).version for _ in range(20)}
    assert len(sticky) == 1
    assert router.cache.hits > 0

    with pytest.raises(RegistryError):
        await registry.set_alias(project, "bot", "prod", {"versions": [{"version": 7, "weight": 100}]}, "key:a")
    with pytest.raises(ValueError):
        await registry.set_alias(project, "bot", "prod", {"versions": [{"version": 1, "weight": 50}]}, "key:a")
    moves = await pool.fetch("SELECT details FROM audit_log WHERE action = 'alias.move' ORDER BY id")
    assert moves[1]["details"]["from"] == [{"version": 2, "weight": 100}]


def test_parse_target_and_bucket():
    assert parse_target("a@b") == ("a", "b") and parse_target("a") == ("a", "prod")
    assert bucket("x") == bucket("x") and 0 <= bucket("y") < 100


async def test_search(pool, project, registry):
    await registry.register(project, Agent("incident-investigator", "scripted", tools=["shell"], tags=["ops"], description="Investigates alerts").spec(), "key:a")
    await registry.register(project, Agent("writer", "scripted").spec(), "key:b")
    assert [a["name"] for a in await registry.search(project, query="alert")] == ["incident-investigator"]
    assert [a["name"] for a in await registry.search(project, tag="ops")] == ["incident-investigator"]
    assert [a["name"] for a in await registry.search(project, owner="key:b")] == ["writer"]
    assert [a["name"] for a in await registry.search(project, capability="shell")] == ["incident-investigator"]


async def test_step_store_contract(pool, project):
    sid = await make_session(pool, project)
    q = RunQueue(pool)
    run_id = await q.enqueue(None, session_id=sid, project_id=project, input=[])
    steps = PostgresStepStore(pool)
    a = await steps.begin(StepSpec(session_id=sid, run_id=run_id, key="model:0", type="model"))
    assert await steps.begin(StepSpec(session_id=sid, run_id=run_id, key="model:0", type="model")) == a
    assert (await steps.get(run_id, "model:0")).attempts == 2
    await steps.complete(a, {"message": {"role": "assistant", "content": []}})
    assert (await steps.begin(StepSpec(session_id=sid, run_id=run_id, key="model:0", type="model"))) == a
    done = await steps.get(run_id, "model:0")
    assert done.status == "completed" and done.attempts == 2
    b = await steps.begin(StepSpec(session_id=sid, run_id=run_id, key="tool:x", type="tool"))
    assert (await steps.last_completed(run_id)).id == a
    await steps.complete(b, {"result": {"call_id": "x", "content": "ok"}})
    assert [s.key for s in await steps.session_steps(sid)] == ["model:0", "tool:x"]


async def test_event_log_sequences_per_session(pool, project):
    s1 = await make_session(pool, project, "ses_a")
    s2 = await make_session(pool, project, "ses_b")
    log = PostgresEventLog(pool)
    for _ in range(3):
        await log.append(Event(session_id=s1, type="message.agent.delta", payload={"text": "x"}))
    e = await log.append(Event(session_id=s2, type="run.started"))
    assert e.seq == 1
    events = await log.read(s1)
    assert [x.seq for x in events] == [1, 2, 3] and events[0].payload == {"text": "x"}
    assert [x.seq for x in await log.read(s1, after_seq=2)] == [3]


async def test_queue_claim_lease_and_takeover(pool, project):
    q = RunQueue(pool, lease_seconds=30)
    sid = await make_session(pool, project)
    r1 = await q.enqueue(None, session_id=sid, project_id=project, input=[{"role": "user", "content": []}])
    r2 = await q.enqueue(None, session_id=sid, project_id=project, input=[])
    claimed = await q.claim("w1")
    assert claimed["id"] == r1 and claimed["attempts"] == 1
    assert await q.claim("w2") is None  # r2 waits for r1: one run per session at a time
    assert await q.heartbeat(r1, "w1")
    assert not await q.heartbeat(r1, "w2")
    # Simulate a dead worker: the lease expires and another worker takes the run over.
    await pool.execute("UPDATE runs SET lease_until = now() - interval '1 second' WHERE id = $1", r1)
    taken = await q.claim("w2")
    assert taken["id"] == r1 and taken["worker_id"] == "w2" and taken["attempts"] == 2
    assert not await q.heartbeat(r1, "w1")  # the old worker learns it lost the lease
    assert await q.finish(r1, "w2", status="finished", stop_reason="end_turn", usage={}, output="ok", error=None, model="m")
    assert (await q.claim("w1"))["id"] == r2


async def test_queue_cancel_and_waiting(pool, project):
    q = RunQueue(pool)
    sid = await make_session(pool, project)
    r1 = await q.enqueue(None, session_id=sid, project_id=project, input=[])
    await q.claim("w1")
    await q.request_cancel(r1)
    assert not await q.heartbeat(r1, "w1")  # the worker sees the cancel on its next heartbeat
    await q.finish(r1, "w1", status="waiting", stop_reason="approval_pending", usage={}, output=None, error=None, model=None)
    assert await q.claim("w1") is None
    await q.requeue_waiting(r1)
    assert (await q.claim("w1"))["id"] == r1


async def test_steering_queue(pool, project):
    sid = await make_session(pool, project)
    q = RunQueue(pool)
    rid = await q.enqueue(None, session_id=sid, project_id=project, input=[])
    st = PostgresSteeringQueue(pool, rid)
    assert not await st.pending()
    for text in ("one", "two"):
        await pool.execute(
            "INSERT INTO steering (session_id, run_id, message) VALUES ($1, $2, $3)", sid, rid, Message.user(text).model_dump(mode="json")
        )
    assert await st.pending()
    assert [m.text for m in await st.take()] == ["one", "two"]
    assert await st.take() == [] and not await st.pending()
