from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import io
import json
import os
import tarfile
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from agents import Agent
from agents.adapters import AdapterRegistry
from agents.sandbox.local import LocalSandboxProvider
from agents.testing import ScriptedAdapter, call, text
from agents_server.api import create_app
from agents_server.auth import bootstrap, create_key
from agents_server.blobs import FileBlobStore
from agents_server.config import Settings
from agents_server.scheduler import Scheduler
from agents_server.services import Services

ADMIN = "ak_test_admin"


@pytest.fixture
async def env(pool, dsn, tmp_path):
    adapter = ScriptedAdapter([])
    adapters = AdapterRegistry()
    adapters.register("scripted", adapter)
    settings = Settings(
        database_url=dsn,
        master_key=base64.b64encode(os.urandom(32)).decode(),
        blob_url=f"file://{tmp_path}/blobs",
        sandbox_provider="local",
        lease_seconds=5,
        public_url="https://agents.example.com",
    )
    services = await Services.start(settings, pool=pool, adapters=adapters, blobs=FileBlobStore(str(tmp_path / "blobs")), run_migrations=False)
    project = await bootstrap(pool, ADMIN)
    sandboxes = LocalSandboxProvider()
    stop = asyncio.Event()
    worker = services.worker(worker_id="w-api", sandboxes=lambda e: sandboxes)
    task = asyncio.create_task(worker.run_forever(stop, poll_interval=0.05, hub=services.hub))
    app = create_app(services)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers={"Authorization": f"Bearer {ADMIN}"}, timeout=30
    )
    yield {"client": client, "adapter": adapter, "services": services, "project": project, "pool": pool, "sandboxes": sandboxes}
    stop.set()
    await asyncio.wait_for(task, 10)
    await client.aclose()
    await services.hub.stop()


async def register(client, agent: Agent, alias: str | None = "prod") -> int:
    r = await client.post("/v1/agents", json=agent.spec().model_dump(mode="json"))
    assert r.status_code in (200, 201), r.text
    version = r.json()["version"]
    if alias:
        r = await client.put(f"/v1/agents/{agent.name}/aliases/{alias}", json={"versions": [{"version": version, "weight": 100}]})
        assert r.status_code == 200, r.text
    return version


def sse_events(body: str) -> list[dict]:
    out = []
    for chunk in body.split("\n\n"):
        data = [line[6:] for line in chunk.splitlines() if line.startswith("data: ")]
        if data:
            out.append(json.loads("\n".join(data)))
    return out


async def test_auth_roles_and_rate_limit(env):
    c = env["client"]
    assert (await c.get("/v1/agents", headers={"Authorization": ""})).status_code == 401
    assert (await c.get("/v1/agents", headers={"Authorization": "Bearer nope"})).status_code == 401
    _, viewer = await create_key(env["pool"], env["project"], "viewer", "viewer")
    vh = {"Authorization": f"Bearer {viewer}"}
    assert (await c.get("/v1/agents", headers=vh)).status_code == 200
    r = await c.post("/v1/agents", json=Agent("x", "scripted").spec().model_dump(mode="json"), headers=vh)
    assert r.status_code == 403
    r = await c.post("/v1/keys", json={"name": "ci", "role": "developer"})
    assert r.status_code == 201 and r.json()["key"].startswith("ak_")
    assert (await c.get("/v1/project")).json()["role"] == "admin"


async def test_register_versions_aliases_and_rollback(env):
    c = env["client"]
    spec = Agent("bot", "scripted", "v1").spec().model_dump(mode="json")
    r = await c.post("/v1/agents", json=spec)
    assert r.status_code == 201 and r.json()["version"] == 1
    r = await c.post("/v1/agents", json=spec)
    assert r.status_code == 200 and r.json()["created"] is False
    await c.post("/v1/agents", json=Agent("bot", "scripted", "v2").spec().model_dump(mode="json"))
    bad = await c.post("/v1/agents", json={"name": "bad", "models": ["nope-model"], "tools": [{"type": "function", "name": "f"}]})
    assert bad.status_code == 422 and len(bad.json()["problems"]) == 2
    assert [v["version"] for v in (await c.get("/v1/agents/bot/versions")).json()["versions"]] == [2, 1]
    await c.put("/v1/agents/bot/aliases/prod", json={"versions": [{"version": 1, "weight": 100}]})
    r = await c.put("/v1/agents/bot/aliases/prod", json={"versions": [{"version": 1, "weight": 80}, {"version": 2, "weight": 20}]})
    assert r.status_code == 200
    assert (await c.put("/v1/agents/bot/aliases/prod", json={"versions": [{"version": 1, "weight": 50}]})).status_code == 422
    r = await c.post("/v1/agents/bot/aliases/prod/rollback")
    assert r.json()["versions"] == [{"version": 1, "weight": 100}]
    card = (await c.get("/v1/agents/bot@prod/card")).json()
    assert card["name"] == "bot" and card["url"] == "https://agents.example.com/v1/agents/bot@prod/invoke"
    assert (await c.get("/v1/agents/bot@canary/card")).status_code == 404
    assert [a["name"] for a in (await c.get("/v1/agents", params={"q": "bo"})).json()["agents"]] == ["bot"]


async def test_invoke_sync_async_and_stream(env):
    c, adapter = env["client"], env["adapter"]
    await register(c, Agent("bot", "scripted"))
    adapter.turns += [text("sync answer"), text("async answer"), text("streamed answer")]
    r = await c.post("/v1/agents/bot@prod/invoke", json={"input": "q1"})
    assert r.status_code == 200 and r.json()["output"] == "sync answer" and r.json()["version"] == 1
    r = await c.post("/v1/agents/bot@prod/invoke", json={"input": "q2", "mode": "async"})
    assert r.status_code == 202
    sid = r.json()["session_id"]
    for _ in range(100):
        if (await c.get(f"/v1/sessions/{sid}")).json()["status"] == "idle":
            break
        await asyncio.sleep(0.05)
    r = await c.post("/v1/agents/bot/invoke", json={"input": "q3", "stream": True})
    assert r.headers["content-type"].startswith("text/event-stream")
    events = sse_events(r.text)
    assert events[0]["type"] == "route.resolved"
    assert "".join(e["payload"]["text"] for e in events if e["type"] == "message.agent.delta").strip() == "streamed answer"
    assert events[-1]["type"] == "session.status" and events[-1]["payload"]["status"] == "idle"
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    # Reconnect with Last-Event-ID replays only what came after.
    sid = events[0]["session_id"]
    r = await c.get(f"/v1/sessions/{sid}/stream", params={"until_settled": "true"}, headers={"Last-Event-ID": "3"})
    replay = sse_events(r.text)
    assert replay[0]["seq"] == 4 and replay[-1]["payload"].get("status") == "idle"
    history = (await c.get(f"/v1/sessions/{sid}/events", params={"after": 0})).json()["events"]
    assert len(history) == len(events)
    assert (await c.post("/v1/agents/missing@prod/invoke", json={"input": "x"})).status_code == 404


async def test_session_input_approvals_interrupt_and_artifacts(env):
    c, adapter = env["client"], env["adapter"]
    await register(c, Agent("ops", "scripted", tools=[{"builtin": "shell", "approval": {"when": "'deploy' in args.command"}}]))
    adapter.turns += [
        call("shell", {"command": "echo deploy-log > /workspace/outputs/report.md && echo deploy"}, id="d1"),
        text("deployed"),
        text("follow-up"),
    ]
    r = await c.post("/v1/agents/ops/invoke", json={"input": "ship it"})
    body = r.json()
    assert body["stop_reason"] == "approval_pending" and body["status"] == "waiting"
    sid = body["session_id"]
    seen = len((await c.get(f"/v1/sessions/{sid}/events")).json()["events"])
    r = await c.post(f"/v1/sessions/{sid}/events", json={"type": "tool.approval.decided", "call_id": "d1", "decision": "approve"})
    assert r.json()["resumed"] is True
    r = await c.get(f"/v1/sessions/{sid}/stream", params={"until_settled": "true", "after": seen})
    statuses = [e["payload"]["status"] for e in sse_events(r.text) if e["type"] == "session.status"]
    assert statuses[-1] == "idle"
    r = await c.post(f"/v1/sessions/{sid}/events", json={"type": "message.user", "text": "and?"})
    assert r.json()["steered"] is False
    for _ in range(100):
        s = (await c.get(f"/v1/sessions/{sid}")).json()
        if s["status"] == "idle" and s["active_run"] is None:
            break
        await asyncio.sleep(0.05)
    arts = (await c.get(f"/v1/sessions/{sid}/artifacts")).json()["artifacts"]
    assert [a["path"] for a in arts] == ["report.md"]
    dl = await c.get(f"/v1/sessions/{sid}/artifacts/{arts[0]['id']}")
    assert dl.content == b"deploy-log\n" and "report.md" in dl.headers["content-disposition"]
    assert (await c.post(f"/v1/sessions/{sid}/interrupt")).json()["interrupted"] is False
    assert (await c.delete(f"/v1/sessions/{sid}")).status_code == 204
    assert (await c.post(f"/v1/sessions/{sid}/events", json={"type": "message.user", "text": "x"})).status_code == 409


async def test_deployments_http_webhook_queue_and_cron(env):
    c, adapter, services = env["client"], env["adapter"], env["services"]
    version = await register(c, Agent("investigator", "scripted"), alias=None)
    r = await c.post(
        "/v1/deployments",
        json={
            "agent": "investigator",
            "alias": "prod",
            "version": version,
            "triggers": [
                {"type": "http"},
                {"type": "webhook", "provider": "github", "input": "Issue opened: {issue.title}"},
                {"type": "queue", "name": "alerts"},
                {"type": "cron", "schedule": "*/30 * * * *", "input": "Check error budgets"},
            ],
            "concurrency": 5,
        },
    )
    assert r.status_code == 201, r.text
    dep = r.json()
    assert dep["webhook_url"] == f"https://agents.example.com/v1/hooks/{dep['id']}"
    secret = dep["webhook_secret"]
    assert (await c.get(f"/v1/deployments/{dep['name']}")).json()["webhook_secret"] is None
    bad = await c.post("/v1/deployments", json={"agent": "investigator", "triggers": [{"type": "cron", "schedule": "nope", "input": "x"}]})
    assert bad.status_code == 422

    adapter.turns += [text("via http"), text("via webhook"), text("via queue"), text("via cron")]
    r = await c.post(f"/v1/deployments/{dep['name']}/invoke", json={"input": "hi"})
    assert r.json()["output"] == "via http"

    payload = json.dumps({"action": "opened", "issue": {"title": "Login broken"}}).encode()
    sig = "sha256=" + hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    hook = await c.post(f"/v1/hooks/{dep['id']}", content=payload, headers={"X-Hub-Signature-256": sig, "X-GitHub-Event": "issues", "Authorization": ""})
    assert hook.status_code == 202, hook.text
    assert (await c.post(f"/v1/hooks/{dep['id']}", content=payload, headers={"X-Hub-Signature-256": "sha256=bad"})).status_code == 401
    run = await services.platform.wait_for_run(hook.json()["run_id"], timeout=10)
    assert run["output"] == "via webhook"
    assert run["input"][0]["content"][0]["text"] == "Issue opened: Login broken"

    q = await c.post("/v1/queues/alerts/messages", json={"input": "disk full"})
    assert q.status_code == 202 and q.json()["started"][0]["deployment"] == dep["name"]
    await services.platform.wait_for_run(q.json()["started"][0]["run_id"], timeout=10)

    sched = Scheduler(services.platform)
    now = datetime(2026, 10, 14, 9, 10, tzinfo=UTC)
    assert (await sched.tick(now))["cron_fired"] == 0  # first tick schedules 09:30
    assert (await sched.tick(now + timedelta(minutes=19)))["cron_fired"] == 0
    assert (await sched.tick(now + timedelta(minutes=21)))["cron_fired"] == 1
    assert (await sched.tick(now + timedelta(minutes=22)))["cron_fired"] == 0
    cron_run = await env["pool"].fetchval("SELECT id FROM runs WHERE trigger->>'type' = 'cron'")
    assert (await services.platform.wait_for_run(cron_run, timeout=10))["output"] == "via cron"

    r = await c.patch(f"/v1/deployments/{dep['name']}", json={"status": "paused"})
    assert r.json()["status"] == "paused"
    assert (await c.post(f"/v1/deployments/{dep['name']}/invoke", json={"input": "x"})).status_code == 409
    assert (await c.delete(f"/v1/deployments/{dep['name']}")).status_code == 204
    assert (await c.get("/v1/deployments")).json()["deployments"] == []


async def test_concurrency_limit(env):
    c = env["client"]
    version = await register(c, Agent("busy", "scripted"), alias=None)
    dep = (await c.post("/v1/deployments", json={"agent": "busy", "version": version, "concurrency": 1})).json()
    env["adapter"].turns += [lambda req: (_ for _ in ()).throw(AssertionError("unused"))]
    await env["pool"].execute(
        "INSERT INTO sessions (id, project_id, deployment_id, agent, version) VALUES ('ses_busy', $1, $2, 'busy', 1)", env["project"], dep["id"]
    )
    await env["pool"].execute(
        "INSERT INTO runs (id, session_id, project_id, status, worker_id, lease_until) VALUES ('run_busy', 'ses_busy', $1, 'running', 'other', now() + interval '1 hour')",
        env["project"],
    )
    r = await c.post(f"/v1/deployments/{dep['name']}/invoke", json={"input": "x", "mode": "async"})
    assert r.status_code == 429


async def test_secrets_environments_skills_policy_usage_audit(env):
    c, adapter = env["client"], env["adapter"]
    r = await c.post("/v1/secrets", json={"name": "OBS_TOKEN", "value": "shh"})
    assert r.status_code == 201 and r.json()["version"] == 1
    listed = (await c.get("/v1/secrets")).json()["secrets"]
    assert listed[0]["name"] == "OBS_TOKEN" and "value" not in listed[0]
    assert (await c.post("/v1/environments", json={"name": "small", "provider": "local", "timeout_s": 60})).status_code == 201
    assert (await c.get("/v1/environments")).json()["environments"][0]["name"] == "small"

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data in {"SKILL.md": b"---\nname: runbooks\ndescription: Ops runbooks\n---\nRestart first.\n", "scripts/x.sh": b"echo x\n"}.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    r = await c.post("/v1/skills", content=buf.getvalue(), headers={"Content-Type": "application/gzip"})
    assert r.status_code == 201, r.text
    skill = r.json()
    spec = Agent("ops", "scripted", tools=["shell"]).spec().model_dump(mode="json")
    spec["skills"] = [{"name": "runbooks", "version": skill["version"], "description": skill["description"]}]
    assert (await c.post("/v1/agents", json=spec)).status_code == 201
    await c.put("/v1/agents/ops/aliases/prod", json={"versions": [{"version": 1, "weight": 100}]})
    adapter.turns += [call("shell", {"command": "cat /workspace/skills/runbooks/SKILL.md"}, id="k"), text("read")]
    r = await c.post("/v1/agents/ops/invoke", json={"input": "go"})
    assert r.json()["output"] == "read"
    assert "Restart first." in adapter.requests[-1].messages[-1].content[0].content
    assert "runbooks (/workspace/skills/runbooks/SKILL.md): Ops runbooks" in adapter.requests[-1].system

    assert (await c.put("/v1/project/policy", json={"allowed_agents": []})).status_code == 200
    assert (await c.post("/v1/agents/ops/invoke", json={"input": "go"})).status_code == 403
    usage = (await c.get("/v1/usage")).json()["usage"]
    assert usage and usage[0]["runs"] >= 1
    actions = {e["action"] for e in (await c.get("/v1/audit")).json()["entries"]}
    assert {"secret.write", "skill.upload", "agent.register", "alias.move", "project.policy"} <= actions


async def test_slack_and_generic_webhooks(env):
    c = env["client"]
    version = await register(c, Agent("chatops", "scripted"), alias=None)
    dep = (
        await c.post(
            "/v1/deployments",
            json={"agent": "chatops", "version": version, "triggers": [{"type": "webhook", "provider": "slack"}, {"type": "webhook", "provider": "generic"}]},
        )
    ).json()
    secret = dep["webhook_secret"]
    ts = str(int(time.time()))
    body = json.dumps({"type": "url_verification", "challenge": "abc"}).encode()
    sig = "v0=" + hmac.new(secret.encode(), f"v0:{ts}:".encode() + body, hashlib.sha256).hexdigest()
    r = await c.post(f"/v1/hooks/{dep['id']}", content=body, headers={"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig})
    assert r.json() == {"challenge": "abc"}
    from agents.tools.webhook import sign

    env["adapter"].turns += [text("ok")]
    body = b'{"alert": "cpu"}'
    r = await c.post(f"/v1/hooks/{dep['id']}", content=body, headers={"X-Agents-Signature": sign(secret, body, int(time.time()))})
    assert r.status_code == 202


async def test_websocket_streams_and_accepts_input(env):
    import socket

    import uvicorn
    import websockets

    c = env["client"]
    await register(c, Agent("ws", "scripted"))
    env["adapter"].turns += [text("hello over ws"), text("second over ws")]
    r = await c.post("/v1/agents/ws/invoke", json={"input": "hi", "mode": "async"})
    sid = r.json()["session_id"]
    await env["services"].platform.wait_for_run(r.json()["run_id"], timeout=10)

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(env["services"]), host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/v1/sessions/{sid}/ws?token={ADMIN}") as ws:
            seen = []
            while not seen or seen[-1]["payload"].get("status") != "idle":
                seen.append(json.loads(await asyncio.wait_for(ws.recv(), 10)))
            assert any(e["type"] == "message.agent.done" and e["payload"]["text"] == "hello over ws" for e in seen)
            await ws.send(json.dumps({"type": "message.user", "text": "again"}))
            while True:
                ev = json.loads(await asyncio.wait_for(ws.recv(), 10))
                if ev["type"] == "message.agent.done":
                    assert ev["payload"]["text"] == "second over ws"
                    break
        with pytest.raises((websockets.exceptions.InvalidStatus, websockets.exceptions.ConnectionClosed)):
            async with websockets.connect(f"ws://127.0.0.1:{port}/v1/sessions/{sid}/ws?token=bad") as ws:
                await asyncio.wait_for(ws.recv(), 5)
    finally:
        server.should_exit = True
        await serving


def test_openapi_schema_exports():
    from agents_server.__main__ import _OpenAPIOnly

    schema = create_app(services=_OpenAPIOnly()).openapi()  # type: ignore[arg-type]
    paths = set(schema["paths"])
    assert {
        "/v1/agents",
        "/v1/agents/{name}/versions",
        "/v1/agents/{name}/aliases/{alias}",
        "/v1/deployments",
        "/v1/agents/{target}/invoke",
        "/v1/hooks/{ref}",
        "/v1/sessions/{session_id}/events",
        "/v1/sessions/{session_id}/stream",
        "/v1/sessions/{session_id}/interrupt",
        "/v1/sessions/{session_id}/artifacts",
        "/v1/secrets",
        "/v1/environments",
    } <= paths
