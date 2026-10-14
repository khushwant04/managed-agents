"""HTTP clients for a managed-agents server: ``AsyncClient`` and ``Client``.

    client = Client(base_url="https://agents.example.com")   # reads AGENTS_API_KEY
    version = client.agents.register(investigator).version
    client.deployments.create(agent="incident-investigator", alias="prod", version=version,
                              triggers=[{"type": "http"}])
    remote = client.invoke("incident-investigator@prod", input="Why did p99 latency jump?")
    for ev in remote.events():
        ...

Remote sessions expose the same methods and events as local ones. Event
streams resume transparently after a dropped connection (``Last-Event-ID``).
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import tarfile
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from typing import Any

import httpx

from .events import Event
from .session import _LoopThread
from .spec import AgentSpec

SETTLED = {"idle", "waiting_input", "approval_pending", "failed", "terminated"}


class APIError(Exception):
    def __init__(self, status: int, body: Any) -> None:
        self.status = status
        self.body = body
        message = body.get("message") or body.get("detail") or body.get("error") if isinstance(body, dict) else str(body)
        problems = body.get("problems") if isinstance(body, dict) else None
        super().__init__(f"{status}: {message}" + (f" ({'; '.join(problems)})" if problems else ""))

    @property
    def problems(self) -> list[str]:
        return list(self.body.get("problems", [])) if isinstance(self.body, dict) else []


@dataclass
class RegisteredVersion:
    name: str
    version: int
    hash: str
    created: bool
    card: dict[str, Any]


class AsyncClient:
    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        *,
        timeout: float = 60.0,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("AGENTS_BASE_URL") or "http://localhost:8080").rstrip("/")
        key = api_key or os.environ.get("AGENTS_API_KEY")
        headers = {"Authorization": f"Bearer {key}"} if key else {}
        self._http = http_client or httpx.AsyncClient(base_url=self.base_url, timeout=timeout)
        self._http.headers.update(headers)
        self.agents = _Agents(self)
        self.deployments = _Deployments(self)
        self.sessions = _Sessions(self)
        self.secrets = _Secrets(self)
        self.environments = _Environments(self)

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        resp = await self._http.request(method, path, **kwargs)
        if resp.status_code >= 400:
            try:
                body = resp.json()
            except ValueError:
                body = resp.text
            raise APIError(resp.status_code, body)
        if resp.status_code == 204 or not resp.content:
            return None
        if resp.headers.get("content-type", "").startswith("application/json"):
            return resp.json()
        return resp.content

    async def invoke(
        self, target: str, input: str, *, metadata: dict[str, Any] | None = None, deployment: str | None = None
    ) -> RemoteSession:
        """Start a session through the router and return immediately; follow it with ``events()``."""
        body = {"input": input, "mode": "async", "metadata": metadata or {}}
        path = f"/v1/deployments/{deployment}/invoke" if deployment else f"/v1/agents/{target}/invoke"
        data = await self.request("POST", path, json=body)
        return RemoteSession(self, data["session_id"], data["run_id"])

    async def run(self, target: str, input: str, *, timeout: float = 300) -> dict[str, Any]:
        """Invoke and wait for the run to finish; returns output, stop reason and usage."""
        return await self.request(
            "POST", f"/v1/agents/{target}/invoke", json={"input": input, "mode": "sync", "wait_timeout": timeout}, timeout=timeout + 30
        )

    async def stream_events(
        self, session_id: str, *, after: int = 0, until_settled: bool = True, retries: int = 5
    ) -> AsyncIterator[Event]:
        """Follow a session's SSE stream, reconnecting with ``Last-Event-ID`` on drops."""
        last = after
        attempt = 0
        running = False
        while True:
            try:
                headers = {"Last-Event-ID": str(last), "Accept": "text/event-stream"}
                params = {"until_settled": "true" if until_settled else "false"}
                async with self._http.stream(
                    "GET", f"/v1/sessions/{session_id}/stream", headers=headers, params=params, timeout=httpx.Timeout(30, read=None)
                ) as resp:
                    if resp.status_code >= 400:
                        await resp.aread()
                        raise APIError(resp.status_code, _json_or_text(resp))
                    async for ev in _parse_sse(resp.aiter_lines()):
                        attempt = 0
                        last = ev.seq
                        yield ev
                        if ev.type != "session.status":
                            running = True
                        elif ev.payload.get("status") in ("queued", "running"):
                            running = True
                        elif until_settled and (ev.payload.get("status") == "terminated" or (running and ev.payload.get("status") in SETTLED)):
                            return
                    if until_settled:
                        return
            except (httpx.TransportError, httpx.RemoteProtocolError):
                attempt += 1
                if attempt > retries:
                    raise
                await asyncio.sleep(min(0.5 * 2**attempt, 10))

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> AsyncClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()


def _json_or_text(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return resp.text


async def _parse_sse(lines: AsyncIterator[str]) -> AsyncIterator[Event]:
    data: list[str] = []
    async for line in lines:
        if line == "":
            if data:
                yield Event.model_validate(json.loads("\n".join(data)))
                data = []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        if field == "data":
            data.append(value[1:] if value.startswith(" ") else value)
    if data:
        yield Event.model_validate(json.loads("\n".join(data)))


class RemoteSession:
    """A hosted session; the same surface as a local ``AsyncSession``."""

    def __init__(self, client: AsyncClient, session_id: str, run_id: str | None = None) -> None:
        self.client = client
        self.id = session_id
        self.run_id = run_id
        self._cursor = 0
        self._info: dict[str, Any] = {}

    async def events(self) -> AsyncIterator[Event]:
        async for ev in self.client.stream_events(self.id, after=self._cursor):
            self._cursor = ev.seq
            yield ev

    async def history(self, after: int = 0) -> list[Event]:
        data = await self.client.request("GET", f"/v1/sessions/{self.id}/events", params={"after": after})
        return [Event.model_validate(e) for e in data["events"]]

    async def send(self, text: str) -> dict[str, Any]:
        return await self.client.sessions.send(self.id, text)

    async def approve(self, call_id: str, approved: bool = True, reason: str | None = None) -> dict[str, Any]:
        return await self.client.sessions.approve(self.id, call_id, approved, reason)

    async def deny(self, call_id: str, reason: str | None = None) -> dict[str, Any]:
        return await self.approve(call_id, False, reason)

    async def interrupt(self) -> dict[str, Any]:
        return await self.client.sessions.interrupt(self.id)

    async def close(self) -> None:
        await self.client.sessions.terminate(self.id)

    async def wait(self) -> dict[str, Any]:
        async for _ in self.events():
            pass
        self._info = await self.client.sessions.get(self.id)
        return self._info

    @property
    def output(self) -> str:
        run = self._info.get("last_run") or {}
        return run.get("output") or ""

    async def artifacts(self) -> list[dict[str, Any]]:
        return await self.client.sessions.artifacts(self.id)

    async def download(self, artifact_id: str) -> bytes:
        return await self.client.sessions.download(self.id, artifact_id)


class _Resource:
    def __init__(self, client: AsyncClient) -> None:
        self.c = client


class _Agents(_Resource):
    async def register(self, agent: Any) -> RegisteredVersion:
        """Register an ``Agent`` (uploading its local skills first), an ``AgentSpec`` or a dict."""
        from .agent import Agent

        if isinstance(agent, Agent):
            spec = await self._hosted_spec(agent)
        elif isinstance(agent, AgentSpec):
            spec = agent.model_dump(mode="json")
        else:
            spec = dict(agent)
        data = await self.c.request("POST", "/v1/agents", json=spec)
        return RegisteredVersion(**data)

    async def _hosted_spec(self, agent: Any) -> dict[str, Any]:
        spec = agent.spec()
        for ref in spec.tools:
            if ref.type == "function" and not ref.url and not ref.options.get("script"):
                raise ValueError(
                    f"tool {ref.name!r} only runs in-process; give it a url (@tool(url=...)) or ship it to the "
                    "sandbox (@tool(sandbox=True)) to deploy it"
                )
        skills = []
        for skill in agent.skills:
            uploaded = await self.c.request("POST", "/v1/skills", content=_bundle(skill.files), headers={"Content-Type": "application/gzip"})
            skills.append({"name": uploaded["name"], "version": uploaded["version"], "description": uploaded["description"]})
        data = spec.model_dump(mode="json")
        data["skills"] = skills
        return data

    async def versions(self, name: str) -> list[dict[str, Any]]:
        return (await self.c.request("GET", f"/v1/agents/{name}/versions"))["versions"]

    async def get(self, name: str, version: int) -> dict[str, Any]:
        return await self.c.request("GET", f"/v1/agents/{name}/versions/{version}")

    async def search(self, q: str | None = None, **filters: str) -> list[dict[str, Any]]:
        params = {k: v for k, v in {"q": q, **filters}.items() if v is not None}
        return (await self.c.request("GET", "/v1/agents", params=params))["agents"]

    async def set_alias(self, name: str, alias: str, versions: dict[int, int] | list[dict[str, int]]) -> dict[str, Any]:
        """``versions`` is ``{14: 90, 15: 10}`` (version → weight) or the API's list form."""
        items = [{"version": v, "weight": w} for v, w in versions.items()] if isinstance(versions, dict) else versions
        return await self.c.request("PUT", f"/v1/agents/{name}/aliases/{alias}", json={"versions": items})

    async def promote(self, name: str, version: int, alias: str = "prod") -> dict[str, Any]:
        return await self.set_alias(name, alias, {version: 100})

    async def canary(self, name: str, version: int, percent: int, alias: str = "prod") -> dict[str, Any]:
        """Send ``percent`` of new sessions on ``alias`` to ``version``; the rest stay on its current version."""
        current = next((a for a in await self.aliases(name) if a["alias"] == alias), None)
        if current is None:
            raise ValueError(f"{name} has no alias {alias!r} yet; promote a version first")
        base = max(current["versions"], key=lambda v: v["weight"])["version"]
        return await self.set_alias(name, alias, {base: 100 - percent, version: percent})

    async def rollback(self, name: str, alias: str = "prod") -> dict[str, Any]:
        return await self.c.request("POST", f"/v1/agents/{name}/aliases/{alias}/rollback")

    async def aliases(self, name: str) -> list[dict[str, Any]]:
        return (await self.c.request("GET", f"/v1/agents/{name}/aliases"))["aliases"]

    async def card(self, target: str) -> dict[str, Any]:
        return await self.c.request("GET", f"/v1/agents/{target}/card")


class _Deployments(_Resource):
    async def create(
        self,
        agent: str,
        *,
        alias: str = "prod",
        version: int | None = None,
        triggers: list[dict[str, Any]] | None = None,
        name: str | None = None,
        concurrency: int = 10,
        environment: str | None = None,
        secrets: list[str] | None = None,
        budget: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = {
            "agent": agent,
            "alias": alias,
            "version": version,
            "triggers": triggers or [{"type": "http"}],
            "name": name,
            "concurrency": concurrency,
            "environment": environment,
            "secrets": secrets or [],
            "budget": budget or {},
        }
        return await self.c.request("POST", "/v1/deployments", json={k: v for k, v in body.items() if v is not None})

    async def list(self) -> list[dict[str, Any]]:
        return (await self.c.request("GET", "/v1/deployments"))["deployments"]

    async def get(self, ref: str) -> dict[str, Any]:
        return await self.c.request("GET", f"/v1/deployments/{ref}")

    async def update(self, ref: str, **changes: Any) -> dict[str, Any]:
        return await self.c.request("PATCH", f"/v1/deployments/{ref}", json=changes)

    async def pause(self, ref: str) -> dict[str, Any]:
        return await self.update(ref, status="paused")

    async def resume(self, ref: str) -> dict[str, Any]:
        return await self.update(ref, status="active")

    async def delete(self, ref: str) -> None:
        await self.c.request("DELETE", f"/v1/deployments/{ref}")

    async def invoke(self, ref: str, input: str) -> RemoteSession:
        return await self.c.invoke("", input, deployment=ref)


class _Sessions(_Resource):
    async def get(self, session_id: str) -> dict[str, Any]:
        return await self.c.request("GET", f"/v1/sessions/{session_id}")

    async def list(self, agent: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if agent:
            params["agent"] = agent
        return (await self.c.request("GET", "/v1/sessions", params=params))["sessions"]

    def attach(self, session_id: str) -> RemoteSession:
        return RemoteSession(self.c, session_id)

    async def send(self, session_id: str, text: str) -> dict[str, Any]:
        return await self.c.request("POST", f"/v1/sessions/{session_id}/events", json={"type": "message.user", "text": text})

    async def approve(self, session_id: str, call_id: str, approved: bool = True, reason: str | None = None) -> dict[str, Any]:
        body = {"type": "tool.approval.decided", "call_id": call_id, "approved": approved, "reason": reason}
        return await self.c.request("POST", f"/v1/sessions/{session_id}/events", json=body)

    async def interrupt(self, session_id: str) -> dict[str, Any]:
        return await self.c.request("POST", f"/v1/sessions/{session_id}/interrupt")

    async def terminate(self, session_id: str) -> None:
        await self.c.request("DELETE", f"/v1/sessions/{session_id}")

    async def artifacts(self, session_id: str) -> list[dict[str, Any]]:
        return (await self.c.request("GET", f"/v1/sessions/{session_id}/artifacts"))["artifacts"]

    async def download(self, session_id: str, artifact_id: str) -> bytes:
        return await self.c.request("GET", f"/v1/sessions/{session_id}/artifacts/{artifact_id}")


class _Secrets(_Resource):
    async def set(self, name: str, value: str) -> dict[str, Any]:
        return await self.c.request("POST", "/v1/secrets", json={"name": name, "value": value})

    async def list(self) -> list[dict[str, Any]]:
        return (await self.c.request("GET", "/v1/secrets"))["secrets"]

    async def delete(self, name: str) -> None:
        await self.c.request("DELETE", f"/v1/secrets/{name}")


class _Environments(_Resource):
    async def put(self, name: str, **spec: Any) -> dict[str, Any]:
        return await self.c.request("POST", "/v1/environments", json={"name": name, **spec})

    async def list(self) -> list[dict[str, Any]]:
        return (await self.c.request("GET", "/v1/environments"))["environments"]


def _bundle(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel, data in sorted(files.items()):
            info = tarfile.TarInfo(rel)
            info.size = len(data)
            info.mtime = 0
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


# -- sync API -------------------------------------------------------------------


class _SyncProxy:
    """Runs an async resource's coroutines on the client's private loop."""

    def __init__(self, target: Any, loop: _LoopThread, wrap: Any = None) -> None:
        self._target = target
        self._loop = loop
        self._wrap = wrap

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._target, name)
        if not callable(attr):
            return attr

        def call(*args: Any, **kwargs: Any) -> Any:
            result = attr(*args, **kwargs)
            if asyncio.iscoroutine(result):
                result = self._loop.call(result)
            if isinstance(result, RemoteSession):
                return SyncRemoteSession(result, self._loop)
            return result

        return call


class SyncRemoteSession:
    def __init__(self, inner: RemoteSession, loop: _LoopThread) -> None:
        self._inner = inner
        self._loop = loop

    @property
    def id(self) -> str:
        return self._inner.id

    @property
    def output(self) -> str:
        return self._inner.output

    def events(self) -> Iterator[Event]:
        agen = self._inner.events()
        while True:
            try:
                yield self._loop.call(agen.__anext__())
            except StopAsyncIteration:
                return

    def __getattr__(self, name: str) -> Any:
        return getattr(_SyncProxy(self._inner, self._loop), name)


class Client:
    """Synchronous client; every method mirrors ``AsyncClient``."""

    def __init__(self, base_url: str | None = None, api_key: str | None = None, *, timeout: float = 60.0) -> None:
        self._loop = _LoopThread()
        self._async: AsyncClient = self._loop.call(_make_async(base_url, api_key, timeout))
        self.base_url = self._async.base_url
        for name in ("agents", "deployments", "sessions", "secrets", "environments"):
            setattr(self, name, _SyncProxy(getattr(self._async, name), self._loop))

    def invoke(self, target: str, input: str, **kwargs: Any) -> SyncRemoteSession:
        return SyncRemoteSession(self._loop.call(self._async.invoke(target, input, **kwargs)), self._loop)

    def run(self, target: str, input: str, *, timeout: float = 300) -> dict[str, Any]:
        return self._loop.call(self._async.run(target, input, timeout=timeout))

    def close(self) -> None:
        try:
            self._loop.call(self._async.aclose())
        finally:
            self._loop.stop()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


async def _make_async(base_url: str | None, api_key: str | None, timeout: float) -> AsyncClient:
    return AsyncClient(base_url, api_key, timeout=timeout)
