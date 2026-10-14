"""The gateway: the v1 REST API, SSE and WebSocket streaming, inbound webhooks."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections import defaultdict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from agents.events import Event

from . import metrics, schemas
from .auth import Principal, Role, authenticate, create_key
from .registry import AliasTarget, RegistryError, audit
from .router import RouteError
from .service import Conflict, NotFound, PolicyError
from .services import Services
from .triggers import TriggerError, render_input, slack_url_verification, verify_webhook

SETTLED = {"idle", "waiting_input", "approval_pending", "failed", "terminated"}
KEEPALIVE_S = 15.0


# -- request bodies ------------------------------------------------------------


class InvokeBody(BaseModel):
    input: str
    stream: bool = False
    mode: Literal["sync", "async", "stream"] | None = None
    wait_timeout: float = Field(default=300, gt=0, le=3600)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @property
    def resolved_mode(self) -> str:
        return self.mode or ("stream" if self.stream else "sync")


class SessionEventBody(BaseModel):
    type: Literal["message.user", "tool.approval.decided"]
    text: str | None = None
    call_id: str | None = None
    approved: bool | None = None
    decision: Literal["approve", "deny"] | None = None
    reason: str | None = None


class SecretBody(BaseModel):
    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
    value: str


class KeyBody(BaseModel):
    name: str
    role: Role = "developer"


class QueueMessage(BaseModel):
    input: str
    metadata: dict[str, Any] = Field(default_factory=dict)


# -- rate limiting ---------------------------------------------------------------


class RateLimiter:
    """Token bucket per API key, in process memory (use Redis with several gateways)."""

    def __init__(self, per_minute: int) -> None:
        self.rate = per_minute / 60.0
        self.capacity = float(per_minute)
        self._buckets: dict[str, tuple[float, float]] = defaultdict(lambda: (self.capacity, time.monotonic()))

    def allow(self, key: str, cost: float = 1.0) -> bool:
        tokens, last = self._buckets[key]
        now = time.monotonic()
        tokens = min(self.capacity, tokens + (now - last) * self.rate)
        if tokens < cost:
            self._buckets[key] = (tokens, now)
            return False
        self._buckets[key] = (tokens - cost, now)
        return True


# -- app ----------------------------------------------------------------------------


def create_app(services: Services | None = None) -> FastAPI:
    state: dict[str, Any] = {"services": services}

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owned = state["services"] is None
        if owned:
            state["services"] = await Services.start()
        svc: Services = state["services"]
        state["limiter"] = RateLimiter(svc.settings.rate_limit_per_minute)
        yield
        if owned:
            await svc.stop()

    app = FastAPI(
        title="Managed Agents",
        version="0.1.0",
        description="Register agents, route requests to versions, and run them durably on your own infrastructure.",
        lifespan=lifespan,
    )
    if services is not None:
        state["limiter"] = RateLimiter(services.settings.rate_limit_per_minute)

    def svc() -> Services:
        return state["services"]

    # -- errors --

    @app.exception_handler(RegistryError)
    async def _registry_error(_: Request, exc: RegistryError) -> JSONResponse:
        return JSONResponse({"error": "invalid_definition", "problems": exc.problems}, status_code=422)

    for exc_type, status, code in (
        (RouteError, 404, "not_found"),
        (NotFound, 404, "not_found"),
        (PolicyError, 403, "forbidden"),
        (Conflict, 409, "conflict"),
        (TriggerError, 422, "invalid_trigger"),
        (ValueError, 400, "bad_request"),
    ):

        def _handler(_: Request, exc: Exception, status: int = status, code: str = code) -> JSONResponse:
            return JSONResponse({"error": code, "message": str(exc)}, status_code=status)

        app.add_exception_handler(exc_type, _handler)

    @app.middleware("http")
    async def _count(request: Request, call_next: Any) -> Response:
        response = await call_next(request)
        route = request.scope.get("route")
        metrics.HTTP_REQUESTS.labels(request.method, getattr(route, "path", "unmatched"), str(response.status_code)).inc()
        return response

    # -- auth --

    async def principal(authorization: str | None = Header(default=None)) -> Principal:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "missing bearer API key")
        p = await authenticate(svc().pool, authorization[7:].strip())
        if p is None:
            raise HTTPException(401, "invalid API key")
        if not state["limiter"].allow(p.key_id):
            raise HTTPException(429, "rate limit exceeded")
        return p

    def require(role: Role) -> Any:
        async def dep(p: Principal = Depends(principal)) -> Principal:
            if not p.can(role):
                raise HTTPException(403, f"this needs the {role} role")
            return p

        return dep

    viewer, developer, admin = require("viewer"), require("developer"), require("admin")

    # -- health and metrics --

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz", include_in_schema=False)
    async def readyz() -> dict[str, str]:
        await svc().pool.fetchval("SELECT 1")
        return {"status": "ready"}

    @app.get("/metrics", include_in_schema=False)
    async def metrics_endpoint() -> Response:
        metrics.QUEUE_DEPTH.set(await svc().platform.queue.depth())
        body, ctype = metrics.render()
        return Response(body, media_type=ctype)

    # -- registry --

    @app.post("/v1/agents", status_code=201, tags=["agents"], response_model=schemas.RegisterResult)
    async def register_agent(spec: dict[str, Any], response: Response, p: Principal = Depends(developer)) -> dict[str, Any]:
        platform = svc().platform
        row, created = await platform.registry.register(p.project_id, spec, p.actor, await platform.policy(p.project_id))
        if not created:
            response.status_code = 200
        return {"name": row["name"], "version": row["version"], "hash": row["hash"], "created": created, "card": row["card"]}

    @app.get("/v1/agents", tags=["agents"], response_model=schemas.AgentList)
    async def search_agents(
        q: str | None = None, tag: str | None = None, owner: str | None = None, capability: str | None = None, p: Principal = Depends(viewer)
    ) -> dict[str, Any]:
        return {"agents": await svc().platform.registry.search(p.project_id, query=q, tag=tag, owner=owner, capability=capability)}

    @app.get("/v1/agents/{name}/versions", tags=["agents"], response_model=schemas.VersionList)
    async def list_versions(name: str, p: Principal = Depends(viewer)) -> dict[str, Any]:
        versions = await svc().platform.registry.list_versions(p.project_id, name)
        if not versions:
            raise NotFound(f"unknown agent {name!r}")
        return {"name": name, "versions": versions}

    @app.get("/v1/agents/{name}/versions/{version}", tags=["agents"], response_model=schemas.AgentVersion)
    async def get_version(name: str, version: int, p: Principal = Depends(viewer)) -> dict[str, Any]:
        row = await svc().platform.registry.get_version(p.project_id, name, version)
        if row is None:
            raise NotFound(f"{name} has no version {version}")
        return {k: row[k] for k in ("name", "version", "hash", "spec", "card", "created_by", "created_at")}

    @app.get("/v1/agents/{target}/card", tags=["agents"])
    async def agent_card(target: str, p: Principal = Depends(viewer)) -> dict[str, Any]:
        platform = svc().platform
        route = await platform.router.resolve(p.project_id, target, "card")
        row = await platform.registry.get_version(p.project_id, route.agent, route.version)
        assert row is not None
        return {**row["card"], "url": f"{svc().settings.public_url}/v1/agents/{target}/invoke"}

    @app.get("/v1/agents/{name}/aliases", tags=["agents"], response_model=schemas.AliasList)
    async def list_aliases(name: str, p: Principal = Depends(viewer)) -> dict[str, Any]:
        return {"name": name, "aliases": await svc().platform.registry.list_aliases(p.project_id, name)}

    @app.put("/v1/agents/{name}/aliases/{alias}", tags=["agents"], response_model=schemas.AliasResult)
    async def set_alias(name: str, alias: str, body: AliasTarget, p: Principal = Depends(developer)) -> dict[str, Any]:
        row = await svc().platform.registry.set_alias(p.project_id, name, alias, body, p.actor)
        svc().platform.router.cache.invalidate(f"{p.project_id}:{name}:{alias}")
        return {"name": name, "alias": alias, "versions": row["versions"]}

    @app.post("/v1/agents/{name}/aliases/{alias}/rollback", tags=["agents"], response_model=schemas.AliasResult)
    async def rollback_alias(name: str, alias: str, p: Principal = Depends(developer)) -> dict[str, Any]:
        pool = svc().pool
        last = await pool.fetchval(
            "SELECT details FROM audit_log WHERE project_id = $1 AND action = 'alias.move' AND target = $2 ORDER BY id DESC LIMIT 1",
            p.project_id, f"{name}@{alias}",
        )  # fmt: skip
        if not last or not last.get("from"):
            raise Conflict(f"{name}@{alias} has no earlier target to roll back to")
        row = await svc().platform.registry.set_alias(p.project_id, name, alias, {"versions": last["from"]}, p.actor)
        svc().platform.router.cache.invalidate(f"{p.project_id}:{name}:{alias}")
        return {"name": name, "alias": alias, "versions": row["versions"]}

    # -- invoke --

    async def _respond(
        inv_session: str, inv_run: str, route: Any, body: InvokeBody
    ) -> Response | dict[str, Any]:
        platform = svc().platform
        mode = body.resolved_mode
        base = {"session_id": inv_session, "run_id": inv_run, "agent": route.agent, "alias": route.alias, "version": route.version}
        if mode == "async":
            return JSONResponse(base, status_code=202)
        if mode == "stream":
            return _sse(svc(), inv_session, after=0, until_settled=True)
        run = await platform.wait_for_run(inv_run, timeout=body.wait_timeout)
        return {**base, "status": run["status"], "stop_reason": run["stop_reason"], "output": run["output"], "error": run["error"], "usage": run["usage"]}

    @app.post("/v1/agents/{target}/invoke", tags=["invoke"], response_model=None, responses={200: {"model": schemas.InvokeResult, "description": "mode=sync"}, 202: {"model": schemas.InvokeAccepted, "description": "mode=async"}, 201: {"content": {"text/event-stream": {}}, "description": "mode=stream"}})
    async def invoke(target: str, body: InvokeBody, p: Principal = Depends(developer)) -> Response | dict[str, Any]:
        inv = await svc().platform.invoke(p.project_id, target, body.input, actor=p.actor, metadata=body.metadata, trigger={"type": "api"})
        return await _respond(inv.session_id, inv.run_id, inv.route, body)

    # -- deployments --

    @app.post("/v1/deployments", status_code=201, tags=["deployments"], response_model=schemas.Deployment)
    async def create_deployment(body: dict[str, Any], p: Principal = Depends(developer)) -> dict[str, Any]:
        dep = await svc().platform.create_deployment(p.project_id, body, p.actor)
        svc().platform.router.cache.invalidate()
        return _deployment_view(dep, svc().settings.public_url, reveal=True)

    @app.get("/v1/deployments", tags=["deployments"], response_model=schemas.DeploymentList)
    async def list_deployments(p: Principal = Depends(viewer)) -> dict[str, Any]:
        url = svc().settings.public_url
        return {"deployments": [_deployment_view(d, url) for d in await svc().platform.list_deployments(p.project_id)]}

    @app.get("/v1/deployments/{ref}", tags=["deployments"], response_model=schemas.Deployment)
    async def get_deployment(ref: str, p: Principal = Depends(viewer)) -> dict[str, Any]:
        return _deployment_view(await svc().platform.deployment(p.project_id, ref), svc().settings.public_url)

    @app.patch("/v1/deployments/{ref}", tags=["deployments"], response_model=schemas.Deployment)
    async def update_deployment(ref: str, body: dict[str, Any], p: Principal = Depends(developer)) -> dict[str, Any]:
        dep = await svc().platform.update_deployment(p.project_id, ref, body, p.actor)
        svc().platform.router.cache.invalidate()
        return _deployment_view(dep, svc().settings.public_url)

    @app.delete("/v1/deployments/{ref}", status_code=204, tags=["deployments"])
    async def delete_deployment(ref: str, p: Principal = Depends(developer)) -> Response:
        await svc().platform.update_deployment(p.project_id, ref, {"status": "deleted"}, p.actor)
        return Response(status_code=204)

    async def _deployment_invoke(dep: dict[str, Any], text: str, actor: str, trigger: dict[str, Any], metadata: dict[str, Any] | None = None) -> Any:
        platform = svc().platform
        if dep["status"] != "active":
            raise Conflict(f"deployment {dep['name']} is {dep['status']}")
        if await platform.running_sessions(dep["id"]) >= dep["concurrency"]:
            raise HTTPException(429, f"deployment {dep['name']} is at its concurrency limit ({dep['concurrency']})")
        return await platform.invoke(
            dep["project_id"], f"{dep['agent']}@{dep['alias']}", text, actor=actor, deployment=dep, trigger=trigger, metadata=metadata
        )

    @app.post("/v1/deployments/{ref}/invoke", tags=["deployments"], response_model=None, responses={200: {"model": schemas.InvokeResult}, 202: {"model": schemas.InvokeAccepted}})
    async def invoke_deployment(ref: str, body: InvokeBody, p: Principal = Depends(developer)) -> Response | dict[str, Any]:
        dep = await svc().platform.deployment(p.project_id, ref)
        if not any(t["type"] == "http" for t in dep["triggers"]):
            raise Conflict(f"deployment {dep['name']} has no http trigger")
        inv = await _deployment_invoke(dep, body.input, p.actor, {"type": "http"}, body.metadata)
        return await _respond(inv.session_id, inv.run_id, inv.route, body)

    @app.post("/v1/hooks/{ref}", tags=["deployments"], response_model=None)
    async def inbound_webhook(ref: str, request: Request) -> Response:
        dep = await svc().platform.deployment_by_id(ref)
        if dep is None:
            raise HTTPException(404, "unknown deployment")
        hooks = [t for t in dep["triggers"] if t["type"] == "webhook"]
        if not hooks:
            raise HTTPException(404, "this deployment has no webhook trigger")
        body = await request.body()
        headers = dict(request.headers)
        trigger = next((t for t in hooks if verify_webhook(t.get("provider", "generic"), dep["webhook_secret"], headers, body)), None)
        if trigger is None:
            raise HTTPException(401, "invalid webhook signature")
        if trigger.get("provider") == "slack" and (challenge := slack_url_verification(body)) is not None:
            return JSONResponse({"challenge": challenge})
        text = render_input(trigger.get("input"), trigger.get("provider", "generic"), headers, body)
        inv = await _deployment_invoke(dep, text, f"webhook:{trigger.get('provider', 'generic')}", {"type": "webhook", "provider": trigger.get("provider", "generic")})
        return JSONResponse({"session_id": inv.session_id, "run_id": inv.run_id}, status_code=202)

    @app.post("/v1/queues/{name}/messages", status_code=202, tags=["deployments"], response_model=schemas.QueueResult)
    async def queue_message(name: str, body: QueueMessage, p: Principal = Depends(developer)) -> dict[str, Any]:
        started = []
        for dep in await svc().platform.list_deployments(p.project_id):
            if dep["status"] == "active" and any(t["type"] == "queue" and t.get("name") == name for t in dep["triggers"]):
                inv = await _deployment_invoke(dep, body.input, p.actor, {"type": "queue", "name": name}, body.metadata)
                started.append({"deployment": dep["name"], "session_id": inv.session_id, "run_id": inv.run_id})
        if not started:
            raise NotFound(f"no active deployment listens on queue {name!r}")
        return {"started": started}

    # -- sessions --

    @app.get("/v1/sessions", tags=["sessions"], response_model=schemas.SessionList)
    async def list_sessions(agent: str | None = None, limit: int = Query(50, le=500), p: Principal = Depends(viewer)) -> dict[str, Any]:
        return {"sessions": await svc().platform.list_sessions(p.project_id, agent=agent, limit=limit)}

    @app.get("/v1/sessions/{session_id}", tags=["sessions"], response_model=schemas.Session)
    async def get_session(session_id: str, p: Principal = Depends(viewer)) -> dict[str, Any]:
        s = await svc().platform.session(p.project_id, session_id)
        s.pop("sandbox", None)
        s["active_run"] = await svc().platform.queue.active_run(session_id)
        last = await svc().pool.fetchrow(
            "SELECT id, status, stop_reason, output, error, usage, model, enqueued_at, finished_at FROM runs WHERE session_id = $1 ORDER BY enqueued_at DESC LIMIT 1",
            session_id,
        )
        s["last_run"] = dict(last) if last else None
        return s

    @app.post("/v1/sessions/{session_id}/events", tags=["sessions"], response_model=schemas.SessionEventResult)
    async def send_event(session_id: str, body: SessionEventBody, p: Principal = Depends(developer)) -> dict[str, Any]:
        platform = svc().platform
        if body.type == "message.user":
            if not body.text:
                raise ValueError("message.user needs text")
            return await platform.send_input(p.project_id, session_id, body.text, p.actor)
        if not body.call_id:
            raise ValueError("tool.approval.decided needs call_id")
        approved = body.approved if body.approved is not None else body.decision == "approve"
        return await platform.decide_approval(p.project_id, session_id, body.call_id, approved, body.reason, p.actor)

    @app.get("/v1/sessions/{session_id}/events", tags=["sessions"], response_model=schemas.EventList)
    async def session_events(session_id: str, after: int = 0, limit: int = Query(1000, le=10000), p: Principal = Depends(viewer)) -> dict[str, Any]:
        await svc().platform.session(p.project_id, session_id)
        events = await svc().platform.events.read(session_id, after, limit)
        return {"events": [e.model_dump(mode="json") for e in events]}

    @app.get("/v1/sessions/{session_id}/stream", tags=["sessions"], response_model=None)
    async def stream(
        session_id: str,
        after: int = 0,
        until_settled: bool = False,
        last_event_id: str | None = Header(default=None),
        p: Principal = Depends(viewer),
    ) -> Response:
        await svc().platform.session(p.project_id, session_id)
        start = int(last_event_id) if last_event_id and last_event_id.isdigit() else after
        return _sse(svc(), session_id, after=start, until_settled=until_settled)

    @app.websocket("/v1/sessions/{session_id}/ws")
    async def ws(websocket: WebSocket, session_id: str, after: int = 0, token: str | None = None) -> None:
        auth = websocket.headers.get("authorization", "")
        key = auth[7:].strip() if auth.lower().startswith("bearer ") else token
        p = await authenticate(svc().pool, key or "")
        if p is None:
            await websocket.close(code=4401)
            return
        try:
            await svc().platform.session(p.project_id, session_id)
        except NotFound:
            await websocket.close(code=4404)
            return
        await websocket.accept()

        async def pump() -> None:
            async for ev in svc().platform.events.subscribe(session_id, after):
                await websocket.send_text(ev.model_dump_json())

        sender = asyncio.create_task(pump())
        try:
            while True:
                msg = json.loads(await websocket.receive_text())
                if not p.can("developer"):
                    await websocket.send_text(json.dumps({"type": "error", "payload": {"message": "viewer keys are read-only"}}))
                    continue
                body = SessionEventBody.model_validate(msg)
                try:
                    if body.type == "message.user" and body.text:
                        await svc().platform.send_input(p.project_id, session_id, body.text, p.actor)
                    elif body.type == "tool.approval.decided" and body.call_id:
                        approved = body.approved if body.approved is not None else body.decision == "approve"
                        await svc().platform.decide_approval(p.project_id, session_id, body.call_id, approved, body.reason, p.actor)
                except (Conflict, NotFound, ValueError) as exc:
                    await websocket.send_text(json.dumps({"type": "error", "payload": {"message": str(exc)}}))
        except WebSocketDisconnect:
            pass
        finally:
            sender.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await sender

    @app.post("/v1/sessions/{session_id}/interrupt", tags=["sessions"], response_model=schemas.InterruptResult)
    async def interrupt(session_id: str, p: Principal = Depends(developer)) -> dict[str, Any]:
        return await svc().platform.interrupt(p.project_id, session_id, p.actor)

    @app.delete("/v1/sessions/{session_id}", status_code=204, tags=["sessions"])
    async def terminate(session_id: str, p: Principal = Depends(developer)) -> Response:
        await svc().platform.terminate(p.project_id, session_id, p.actor)
        return Response(status_code=204)

    @app.get("/v1/sessions/{session_id}/artifacts", tags=["sessions"], response_model=schemas.ArtifactList)
    async def artifacts(session_id: str, p: Principal = Depends(viewer)) -> dict[str, Any]:
        return {"artifacts": await svc().platform.list_artifacts(p.project_id, session_id)}

    @app.get("/v1/sessions/{session_id}/artifacts/{artifact_id}", tags=["sessions"], response_model=None)
    async def download_artifact(session_id: str, artifact_id: str, p: Principal = Depends(viewer)) -> Response:
        row, data = await svc().platform.artifact(p.project_id, session_id, artifact_id)
        name = row["path"].rsplit("/", 1)[-1]
        return Response(
            data, media_type=row["content_type"] or "application/octet-stream", headers={"Content-Disposition": f'attachment; filename="{name}"'}
        )

    # -- secrets, environments, skills --

    @app.post("/v1/secrets", status_code=201, tags=["secrets"], response_model=schemas.SecretWritten)
    async def put_secret(body: SecretBody, p: Principal = Depends(admin)) -> dict[str, Any]:
        store = svc().platform.secrets
        if store is None:
            raise Conflict("secrets are disabled: set AGENTS_MASTER_KEY on the server")
        return {"name": body.name, "version": await store.put(p.project_id, body.name, body.value, p.actor)}

    @app.get("/v1/secrets", tags=["secrets"], response_model=schemas.SecretList)
    async def list_secrets(p: Principal = Depends(viewer)) -> dict[str, Any]:
        store = svc().platform.secrets
        return {"secrets": await store.list(p.project_id) if store else []}

    @app.delete("/v1/secrets/{name}", status_code=204, tags=["secrets"])
    async def delete_secret(name: str, p: Principal = Depends(admin)) -> Response:
        store = svc().platform.secrets
        if store is None or not await store.delete(p.project_id, name, p.actor):
            raise NotFound(f"no secret {name}")
        return Response(status_code=204)

    @app.post("/v1/environments", status_code=201, tags=["environments"], response_model=schemas.Environment)
    async def put_environment(body: dict[str, Any], p: Principal = Depends(developer)) -> dict[str, Any]:
        name = body.pop("name", None)
        if not name:
            raise ValueError("an environment needs a name")
        return await svc().platform.put_environment(p.project_id, name, body, p.actor)

    @app.get("/v1/environments", tags=["environments"], response_model=schemas.EnvironmentList)
    async def list_environments(p: Principal = Depends(viewer)) -> dict[str, Any]:
        return {"environments": await svc().platform.list_environments(p.project_id)}

    @app.post("/v1/skills", status_code=201, tags=["skills"], response_model=schemas.SkillUploaded)
    async def upload_skill(request: Request, p: Principal = Depends(developer)) -> dict[str, Any]:
        data = await request.body()
        if len(data) > 20 * 1024 * 1024:
            raise HTTPException(413, "skill bundles are limited to 20 MB")
        return await svc().platform.upload_skill(p.project_id, data, p.actor)

    @app.get("/v1/skills", tags=["skills"], response_model=schemas.SkillList)
    async def list_skills(p: Principal = Depends(viewer)) -> dict[str, Any]:
        recs = await svc().pool.fetch(
            "SELECT name, version, description, size_bytes, created_at FROM skills WHERE project_id = $1 ORDER BY name, created_at", p.project_id
        )
        return {"skills": [dict(r) for r in recs]}

    # -- project administration --

    @app.get("/v1/project", tags=["project"], response_model=schemas.Project)
    async def get_project(p: Principal = Depends(viewer)) -> dict[str, Any]:
        rec = await svc().pool.fetchrow("SELECT id, name, policy, created_at FROM projects WHERE id = $1", p.project_id)
        return {**dict(rec), "role": p.role}

    @app.put("/v1/project/policy", tags=["project"], response_model=schemas.PolicyResult)
    async def put_policy(policy: dict[str, Any], p: Principal = Depends(admin)) -> dict[str, Any]:
        await svc().platform.set_policy(p.project_id, policy, p.actor)
        return {"policy": policy}

    @app.post("/v1/keys", status_code=201, tags=["project"], response_model=schemas.KeyCreated)
    async def new_key(body: KeyBody, p: Principal = Depends(admin)) -> dict[str, Any]:
        key_id, key = await create_key(svc().pool, p.project_id, body.name, body.role)
        await audit(svc().pool, p.project_id, p.actor, "key.create", key_id, {"role": body.role})
        return {"id": key_id, "key": key, "role": body.role}

    @app.delete("/v1/keys/{key_id}", status_code=204, tags=["project"])
    async def revoke_key(key_id: str, p: Principal = Depends(admin)) -> Response:
        res = await svc().pool.execute("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND project_id = $2", key_id, p.project_id)
        if not res.endswith("1"):
            raise NotFound(f"no key {key_id}")
        await audit(svc().pool, p.project_id, p.actor, "key.revoke", key_id)
        return Response(status_code=204)

    @app.get("/v1/usage", tags=["project"], response_model=schemas.UsageList)
    async def usage(days: int = Query(30, le=365), p: Principal = Depends(viewer)) -> dict[str, Any]:
        return {"usage": await svc().platform.usage(p.project_id, days=days)}

    @app.get("/v1/audit", tags=["project"], response_model=schemas.AuditList)
    async def audit_log(limit: int = Query(100, le=1000), p: Principal = Depends(admin)) -> dict[str, Any]:
        recs = await svc().pool.fetch(
            "SELECT actor, action, target, details, at FROM audit_log WHERE project_id = $1 ORDER BY id DESC LIMIT $2", p.project_id, limit
        )
        return {"entries": [dict(r) for r in recs]}

    return app


def _deployment_view(dep: dict[str, Any], public_url: str, *, reveal: bool = False) -> dict[str, Any]:
    view = {k: v for k, v in dep.items() if k != "webhook_secret"}
    if any(t["type"] == "webhook" for t in dep.get("triggers", [])):
        view["webhook_url"] = f"{public_url}/v1/hooks/{dep['id']}"
        if reveal:
            view["webhook_secret"] = dep["webhook_secret"]
    return view


def _sse(services: Services, session_id: str, *, after: int, until_settled: bool) -> StreamingResponse:
    """Server-sent events with resumable ids (the event's ``seq``)."""

    async def gen() -> AsyncIterator[str]:
        if until_settled:
            # Nothing is running: replay what there is and stop instead of waiting.
            status = await services.pool.fetchval("SELECT status FROM sessions WHERE id = $1", session_id)
            if status in SETTLED and await services.platform.queue.active_run(session_id) is None:
                for ev in await services.platform.events.read(session_id, after):
                    yield ev.to_sse()
                return
        events = services.platform.events.subscribe(session_id, after)
        running = False
        nxt: asyncio.Task[Event] | None = None
        try:
            while True:
                nxt = nxt or asyncio.ensure_future(events.__anext__())
                done, _ = await asyncio.wait({nxt}, timeout=KEEPALIVE_S)
                if not done:
                    yield ": keepalive\n\n"
                    continue
                ev = nxt.result()
                nxt = None
                yield ev.to_sse()
                if not until_settled:
                    continue
                if ev.type != "session.status":
                    running = True  # run activity, even when the replay starts mid-run
                    continue
                status = ev.payload.get("status")
                if status in ("queued", "running"):
                    running = True
                elif (running and status in SETTLED) or status == "terminated":
                    return
        except StopAsyncIteration:
            return
        finally:
            if nxt is not None:
                nxt.cancel()
            with contextlib.suppress(Exception):
                await events.aclose()  # type: ignore[attr-defined]

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
