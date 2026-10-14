"""Runtime workers: pull runs from the queue and execute them durably.

A worker leases a run, loads the agent version, creates or resumes the
session's sandbox, and drives the ``Runner`` with Postgres-backed stores. It
heartbeats the lease while the run executes; if the lease is lost (another
worker took over) or a cancel is requested, the run task is cancelled. Any
worker can resume any run from its last completed step.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import shlex
import time
from collections.abc import Callable
from typing import Any

import httpx

from agents.adapters import AdapterRegistry
from agents.events import Event, new_id
from agents.runtime.runner import RunContext, Runner, RunResult
from agents.runtime.toolset import needs_sandbox, system_prompt, tool_specs
from agents.sandbox import provider_for
from agents.sandbox.base import Environment, FileSpec, SandboxHandle, SandboxProvider
from agents.spec import AgentSpec, ToolRef
from agents.tools.executor import CallContext, ToolExecutionError, ToolExecutor, ToolHandler
from agents.types import Message, ToolSpec

from . import metrics
from .queue import RUN_CHANNEL
from .service import Platform
from .stores import PostgresSteeringQueue

log = logging.getLogger("agents.worker")

MAX_MEMORY_BYTES = 5 * 1024 * 1024
MAX_ARTIFACT_BYTES = 50 * 1024 * 1024


class LeaseLost(Exception):
    pass


class Worker:
    def __init__(
        self,
        platform: Platform,
        *,
        worker_id: str,
        adapters: AdapterRegistry | None = None,
        sandboxes: Callable[[Environment], SandboxProvider] | None = None,
        default_provider: str = "e2b",
        concurrency: int = 8,
        lease_seconds: int = 30,
        http_client: httpx.AsyncClient | None = None,
        tool_signing_secret: str | None = None,
    ) -> None:
        self.platform = platform
        self.pool = platform.pool
        self.worker_id = worker_id
        self.adapters = adapters or AdapterRegistry()
        self._sandbox_factory = sandboxes
        self._providers: dict[str, SandboxProvider] = {}
        self.default_provider = default_provider
        self.concurrency = concurrency
        self.lease_seconds = lease_seconds
        self.http = http_client
        self.tool_signing_secret = tool_signing_secret or os.environ.get("AGENTS_TOOL_SIGNING_SECRET") or ""
        self.runner = Runner(self.adapters, platform.steps, platform.events)
        self._wake = asyncio.Event()
        self._slots = asyncio.Semaphore(concurrency)
        self._tasks: set[asyncio.Task[Any]] = set()

    # -- loop -------------------------------------------------------------

    def notify(self, *_: Any) -> None:
        self._wake.set()

    async def run_forever(self, stop: asyncio.Event, *, poll_interval: float = 1.0, hub: Any = None) -> None:
        if hub is not None:
            await hub.listen(RUN_CHANNEL, self.notify)
        log.info("worker %s started (concurrency %d)", self.worker_id, self.concurrency)
        while not stop.is_set():
            await self._slots.acquire()
            run = await self.platform.queue.claim(self.worker_id)
            if run is None:
                self._slots.release()
                self._wake.clear()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), poll_interval)
                continue
            task = asyncio.create_task(self._guarded(run))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    async def _guarded(self, run: dict[str, Any]) -> None:
        try:
            await self.execute(run)
        except Exception:
            log.exception("run %s crashed", run["id"])
        finally:
            self._slots.release()

    async def run_once(self) -> bool:
        """Claim and execute one run (tests and the inline ``call_agent`` path)."""
        run = await self.platform.queue.claim(self.worker_id)
        if run is None:
            return False
        await self.execute(run)
        return True

    # -- one run -----------------------------------------------------------

    async def execute(self, run: dict[str, Any]) -> RunResult | None:
        started = time.monotonic()
        session = dict(await self.pool.fetchrow("SELECT * FROM sessions WHERE id = $1", run["session_id"]))
        project_id = session["project_id"]
        if session["status"] == "terminated" or run.get("cancel_requested"):
            await self._finish(run, session, RunResult(run_id=run["id"], stop_reason="interrupted"), started, 0)
            return None
        spec = await self.platform.spec_for(project_id, session["agent"], session["version"])
        meta = session["metadata"] or {}
        if meta.get("tools") is not None:
            allowed = set(meta["tools"])
            spec = spec.model_copy(update={"tools": [t for t in spec.tools if t.name in allowed], "subagents": meta.get("subagents") and spec.subagents})
        deployment = await self.platform.deployment_by_id(session["deployment_id"]) if session["deployment_id"] else None
        policy = await self.platform.policy(project_id)

        provider, handle = await self._sandbox(session, spec, deployment)
        mcp_clients: list[Any] = []
        try:
            mcp_specs, handlers = await self._tool_gateway(session, spec, deployment, policy, mcp_clients, provider, handle)
            specs = tool_specs(spec, mcp_specs)
            executor = ToolExecutor(
                {t.name: t for t in specs},
                sandbox=provider,
                handle=handle,
                handlers=handlers,
            )
            ctx = RunContext(
                session_id=session["id"],
                run_id=run["id"],
                spec=spec,
                executor=executor,
                tools=specs,
                inputs=[Message.model_validate(m) for m in run["input"]],
                system=system_prompt(spec, has_sandbox=handle is not None),
                steering=PostgresSteeringQueue(self.pool, run["id"]),
                attributes={
                    "agents.agent.version": session["version"],
                    "agents.route.alias": session["alias"],
                    "agents.project_id": project_id,
                    "agents.deployment_id": session["deployment_id"],
                },
            )
            if run["attempts"] == 1:
                await self.platform.set_status(session["id"], "running", run_id=run["id"])
            else:
                await self.platform.set_status(session["id"], "running", run_id=run["id"], resumed=True, attempt=run["attempts"])
                metrics.SESSIONS_RESUMED.inc()
            runner = Runner(self.adapters, self.platform.steps, metrics.MetricsEventLog(self.platform.events, spec.name, started))
            result = await self._run_with_lease(ctx, run, runner)
        except LeaseLost:
            log.warning("run %s: lease lost; another worker owns it now", run["id"])
            return None
        except Exception as exc:
            log.exception("run %s failed", run["id"])
            result = RunResult(run_id=run["id"], stop_reason="error", error=f"{type(exc).__name__}: {exc}")
            await self.platform.events.append(
                Event(session_id=session["id"], run_id=run["id"], type="error", payload={"message": result.error, "fatal": True})
            )
        finally:
            for client in mcp_clients:
                with contextlib.suppress(Exception):
                    await client.aclose()
        if provider is not None and handle is not None and not meta.get("share_sandbox_of"):
            with contextlib.suppress(Exception):
                await self._sync_artifacts(session, run["id"], provider, handle)
            with contextlib.suppress(Exception):
                await self._sync_memory_out(project_id, spec.name, provider, handle)
        tool_calls = await self.pool.fetchval("SELECT count(*) FROM steps WHERE run_id = $1 AND type = 'tool'", run["id"])
        await self._finish(run, session, result, started, tool_calls, deployment, sandboxed=handle is not None)
        return result

    async def _run_with_lease(self, ctx: RunContext, run: dict[str, Any], runner: Runner | None = None) -> RunResult:
        task = asyncio.create_task((runner or self.runner).run(ctx))
        lost = False
        cancelled = False
        interval = max(self.lease_seconds / 3, 0.2)
        try:
            while True:
                done, _ = await asyncio.wait({task}, timeout=interval)
                if done:
                    return task.result()
                rec = await self.pool.fetchrow(
                    """
                    UPDATE runs SET lease_until = now() + make_interval(secs => $3)
                    WHERE id = $1 AND worker_id = $2 AND status = 'running' RETURNING cancel_requested
                    """,
                    run["id"], self.worker_id, float(self.lease_seconds),
                )  # fmt: skip
                if rec is None:
                    lost = True
                elif rec["cancel_requested"]:
                    cancelled = True
                if lost or cancelled:
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
                    if lost:
                        raise LeaseLost(run["id"])
                    return RunResult(run_id=run["id"], stop_reason="interrupted")
        except asyncio.CancelledError:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
            raise

    async def _finish(
        self,
        run: dict[str, Any],
        session: dict[str, Any],
        result: RunResult,
        sandbox_since: float | None,
        tool_calls: int,
        deployment: dict[str, Any] | None = None,
        *,
        sandboxed: bool = False,
    ) -> None:
        status = "waiting" if result.stop_reason == "approval_pending" else "finished"
        if result.stop_reason == "interrupted":
            status = "cancelled"
        owned = await self.platform.queue.finish(
            run["id"],
            self.worker_id,
            status=status,
            stop_reason=result.stop_reason,
            usage=result.usage.model_dump(),
            output=result.output,
            error=result.error,
            model=result.model,
        )
        if not owned:
            return
        # Input that arrived after the runner's last look at the steering queue starts a follow-up run.
        leftover = await self.pool.fetch(
            "UPDATE steering SET consumed_at = now() WHERE run_id = $1 AND consumed_at IS NULL RETURNING id, message", run["id"]
        )
        followed_up = False
        if leftover and status == "finished" and session["status"] != "terminated":
            next_run = await self.platform.queue.enqueue(
                None,
                session_id=session["id"],
                project_id=session["project_id"],
                input=[r["message"] for r in sorted(leftover, key=lambda r: r["id"])],
                trigger={"type": "input", "late_for_run": run["id"]},
            )
            await self.platform.set_status(session["id"], "queued", run_id=next_run)
            followed_up = True
        session_status = {
            "end_turn": "idle",
            "budget": "idle",
            "interrupted": "idle",
            "approval_pending": "approval_pending",
            "needs_input": "waiting_input",
            "error": "failed",
        }[result.stop_reason]
        if session["status"] != "terminated" and not followed_up:
            await self.platform.set_status(session["id"], session_status, run_id=run["id"], stop_reason=result.stop_reason)
        u = result.usage
        await self.pool.execute(
            """
            INSERT INTO usage_records (project_id, deployment_id, session_id, run_id, model, input_tokens, output_tokens,
                                       cache_read_tokens, cache_write_tokens, sandbox_seconds, tool_calls)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            """,
            session["project_id"], deployment["id"] if deployment else session["deployment_id"], session["id"], run["id"], result.model,
            u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
            time.monotonic() - sandbox_since if sandbox_since and sandboxed else 0.0, tool_calls,
        )  # fmt: skip
        metrics.record_run(result, session["agent"])
        if sandbox_since is not None:
            metrics.RUN_LATENCY.labels(session["agent"]).observe(time.monotonic() - sandbox_since)

    # -- sandboxes ---------------------------------------------------------

    def _provider(self, env: Environment) -> SandboxProvider:
        if self._sandbox_factory is not None:
            return self._sandbox_factory(env)
        if env.provider not in self._providers:
            self._providers[env.provider] = provider_for(env)
        return self._providers[env.provider]

    async def _environment(self, session: dict[str, Any], spec: AgentSpec, deployment: dict[str, Any] | None) -> Environment:
        if deployment and deployment.get("environment"):
            data = await self.platform.environment(session["project_id"], deployment["environment"])
            if data:
                return Environment.model_validate(data)
        if spec.environment is not None:
            return spec.environment
        return Environment(provider=self.default_provider)  # type: ignore[arg-type]

    async def _sandbox(
        self, session: dict[str, Any], spec: AgentSpec, deployment: dict[str, Any] | None
    ) -> tuple[SandboxProvider | None, SandboxHandle | None]:
        if not needs_sandbox(spec):
            return None, None
        share = (session["metadata"] or {}).get("share_sandbox_of")
        source = session
        if share:
            source = dict(await self.pool.fetchrow("SELECT * FROM sessions WHERE id = $1", share))
        env = await self._environment(source, spec, deployment)
        provider = self._provider(env)
        if source["sandbox"] and source["sandbox_state"] in ("running", "paused"):
            handle = SandboxHandle.model_validate(source["sandbox"])
            try:
                handle = await provider.resume(handle)
                await self.pool.execute(
                    "UPDATE sessions SET sandbox = $2, sandbox_state = 'running', last_active_at = now() WHERE id = $1",
                    source["id"], handle.model_dump(mode="json"),
                )  # fmt: skip
                return provider, handle
            except Exception as exc:
                log.warning("sandbox %s for session %s is gone (%s); creating a new one", handle.id, source["id"], exc)
        handle = await provider.create(env)
        files: list[FileSpec] = []
        for ref in spec.skills:
            if ref.version:
                skill = await self.platform.load_skill(session["project_id"], ref.name, ref.version)
                files += skill.sandbox_files()
        files += await self._memory_files(session["project_id"], spec.name)
        if files:
            await provider.write_files(handle, files)
        await self.pool.execute(
            "UPDATE sessions SET sandbox = $2, sandbox_state = 'running', last_active_at = now() WHERE id = $1",
            source["id"], handle.model_dump(mode="json"),
        )  # fmt: skip
        return provider, handle

    async def _memory_files(self, project_id: str, agent: str) -> list[FileSpec]:
        recs = await self.pool.fetch("SELECT path, content FROM memory_files WHERE project_id = $1 AND agent = $2", project_id, agent)
        return [FileSpec(path=f"/workspace/memory/{r['path']}", content=bytes(r["content"])) for r in recs]

    async def _list(self, provider: SandboxProvider, handle: SandboxHandle, root: str) -> list[str]:
        res = await provider.exec(handle, f"cd {root} 2>/dev/null && find . -type f | sort", timeout=30)
        return [p[2:] for p in res.stdout.splitlines() if p.startswith("./")]

    async def _sync_memory_out(self, project_id: str, agent: str, provider: SandboxProvider, handle: SandboxHandle) -> None:
        paths = await self._list(provider, handle, "/workspace/memory")
        if not paths:
            return
        files = await provider.read_files(handle, [f"/workspace/memory/{p}" for p in paths])
        total = 0
        for rel, f in zip(paths, files, strict=True):
            total += len(f.content)
            if total > MAX_MEMORY_BYTES:
                log.warning("memory for %s exceeds %d bytes; not all files were saved", agent, MAX_MEMORY_BYTES)
                break
            await self.pool.execute(
                """
                INSERT INTO memory_files (project_id, agent, path, content) VALUES ($1, $2, $3, $4)
                ON CONFLICT (project_id, agent, path) DO UPDATE SET content = EXCLUDED.content, updated_at = now()
                WHERE memory_files.content IS DISTINCT FROM EXCLUDED.content
                """,
                project_id, agent, rel, f.content,
            )  # fmt: skip

    async def _sync_artifacts(self, session: dict[str, Any], run_id: str, provider: SandboxProvider, handle: SandboxHandle) -> None:
        paths = await self._list(provider, handle, "/workspace/outputs")
        if not paths:
            return
        files = await provider.read_files(handle, [f"/workspace/outputs/{p}" for p in paths])
        for rel, f in zip(paths, files, strict=True):
            if len(f.content) > MAX_ARTIFACT_BYTES:
                continue
            digest = hashlib.sha256(f.content).hexdigest()
            key = f"artifacts/{session['project_id']}/{session['id']}/{digest}"
            existing = await self.pool.fetchval("SELECT object_key FROM artifacts WHERE session_id = $1 AND path = $2", session["id"], rel)
            if existing == key:
                continue
            await self.platform.blobs.put(key, f.content)
            art_id = await self.pool.fetchval(
                """
                INSERT INTO artifacts (id, session_id, run_id, path, size_bytes, object_key, content_type) VALUES ($1,$2,$3,$4,$5,$6,$7)
                ON CONFLICT (session_id, path) DO UPDATE SET run_id = EXCLUDED.run_id, size_bytes = EXCLUDED.size_bytes,
                    object_key = EXCLUDED.object_key, created_at = now()
                RETURNING id
                """,
                new_id("art"), session["id"], run_id, rel, len(f.content), key, _content_type(rel),
            )  # fmt: skip
            await self.platform.events.append(
                Event(
                    session_id=session["id"],
                    run_id=run_id,
                    type="artifact.created",
                    payload={"id": art_id, "path": f"/workspace/outputs/{rel}", "size": len(f.content), "sha256": digest},
                )
            )

    # -- tool gateway ------------------------------------------------------

    async def _secret(self, project_id: str, name: str, reason: str) -> str:
        if self.platform.secrets is None:
            raise ToolExecutionError("secrets are not configured on this server (AGENTS_MASTER_KEY)")
        try:
            return await self.platform.secrets.get(project_id, name, actor=f"worker:{self.worker_id}", reason=reason)
        except KeyError:
            raise ToolExecutionError(f"secret {name!r} is not set in this project") from None

    async def _auth_headers(self, project_id: str, ref: ToolRef) -> dict[str, str]:
        headers: dict[str, str] = dict(ref.options.get("headers") or {})
        if len(ref.secrets) == 1:
            headers["Authorization"] = f"Bearer {await self._secret(project_id, ref.secrets[0], f'tool {ref.name}')}"
        else:
            for name in ref.secrets:
                headers[f"X-Agents-Secret-{name}"] = await self._secret(project_id, name, f"tool {ref.name}")
        return headers

    async def _tool_gateway(
        self,
        session: dict[str, Any],
        spec: AgentSpec,
        deployment: dict[str, Any] | None,
        policy: dict[str, Any],
        mcp_clients: list[Any],
        provider: SandboxProvider | None = None,
        handle: SandboxHandle | None = None,
    ) -> tuple[list[ToolSpec], dict[str, ToolHandler]]:
        from agents.tools.mcp import McpClient, mcp_tool_specs
        from agents.tools.webhook import EgressPolicy, WebhookCaller

        project_id = session["project_id"]
        egress = EgressPolicy(policy.get("egress_domains"))
        signing = (deployment or {}).get("webhook_secret") or self.tool_signing_secret or project_id
        caller = WebhookCaller(signing, client=self.http, egress=egress)
        handlers: dict[str, ToolHandler] = {}
        mcp_specs: list[ToolSpec] = []

        for ref in spec.tools:
            if ref.type == "function" and ref.url:
                async def call_webhook(args: dict[str, Any], ctx: CallContext, ref: ToolRef = ref) -> str:
                    return await caller.call(
                        ref.url or "",
                        tool=ref.name,
                        arguments=args,
                        idempotency_key=ctx.idempotency_key,
                        session_id=ctx.session_id,
                        run_id=ctx.run_id,
                        call_id=ctx.call_id,
                        headers=await self._auth_headers(project_id, ref),
                    )

                handlers[ref.name] = call_webhook
            elif ref.type == "function" and ref.options.get("script"):
                handlers[ref.name] = self._script_handler(ref, provider, handle)
            elif ref.type == "mcp" and ref.url:
                egress.check(ref.url)
                client = McpClient(ref.url, headers=await self._auth_headers(project_id, ref), client=self.http)
                await client.connect()
                mcp_clients.append(client)
                specs = mcp_tool_specs(ref.name, await client.list_tools())
                for s in specs:
                    original = s.options["mcp_tool"]

                    async def call_mcp(args: dict[str, Any], ctx: CallContext, client: Any = client, original: str = original) -> str:
                        return await client.call_tool(original, args)

                    handlers[s.name] = call_mcp
                mcp_specs += specs
            elif ref.type == "agent":
                handlers[ref.name] = self._call_agent_handler(session, spec, ref)
        if spec.subagents is not None:
            handlers["spawn_subagent"] = self._subagent_handler(session, spec)
        return mcp_specs, handlers

    def _script_handler(self, ref: ToolRef, provider: SandboxProvider | None, handle: SandboxHandle | None) -> ToolHandler:
        """A function tool shipped as Python source with the agent version, run in the sandbox."""
        source = ref.options["script"]
        entry = ref.options.get("entrypoint", ref.name)
        program = (
            f"{source}\n\nimport json as _j, sys as _s\n_r = {entry}(**_j.loads(_s.stdin.read()))\n"
            "print(_r if isinstance(_r, str) else _j.dumps(_r, default=str))\n"
        )

        async def run_script(args: dict[str, Any], ctx: CallContext) -> str:
            if provider is None or handle is None:
                raise ToolExecutionError(f"{ref.name} runs in the sandbox, but this session has none")
            path = f"/workspace/.tools/{ref.name}.py"
            await provider.write_files(handle, [FileSpec(path=path, content=program.encode())])
            payload = shlex.quote(json.dumps(args))
            res = await provider.exec(handle, f"printf %s {payload} | python3 {path}", timeout=300)
            if res.exit_code != 0:
                raise ToolExecutionError(res.render())
            return res.stdout.rstrip("\n")

        return run_script

    def _call_agent_handler(self, session: dict[str, Any], spec: AgentSpec, ref: ToolRef) -> ToolHandler:
        target = str(ref.options.get("agent", ref.name))

        async def call_agent(args: dict[str, Any], ctx: CallContext) -> str:
            existing = await self._existing_child(ctx)
            if existing:
                return await self._run_child(session, existing["session_id"], existing["id"], ctx, label=target)
            inv = await self.platform.invoke(
                session["project_id"],
                target if "@" in target else f"{target}@prod",
                args["input"],
                actor=f"agent:{spec.name}",
                parent_session_id=session["id"],
                depth=session["depth"] + 1,
                caller_agent=spec.name,
                trigger={"type": "call_agent", "parent_run_id": ctx.run_id, "call_id": ctx.call_id},
            )
            return await self._run_child(session, inv.session_id, inv.run_id, ctx, label=target)

        return call_agent

    def _subagent_handler(self, session: dict[str, Any], spec: AgentSpec) -> ToolHandler:
        policy = spec.subagents
        assert policy is not None
        slots = asyncio.Semaphore(policy.max_concurrent)

        async def spawn(args: dict[str, Any], ctx: CallContext) -> str:
            depth = session["depth"] + 1
            if depth > policy.max_depth:
                raise ToolExecutionError(f"subagent depth limit ({policy.max_depth}) reached")
            allowed = set(policy.tools or [t.name for t in spec.tools])
            if args.get("tools"):
                allowed &= set(args["tools"])
            async with slots:
                existing = await self._existing_child(ctx)
                if existing:
                    return await self._run_child(session, existing["session_id"], existing["id"], ctx, label="subagent")
                inv = await self.platform.invoke(
                    session["project_id"],
                    f"{spec.name}@{session['version']}",
                    args["task"],
                    actor=f"agent:{spec.name}",
                    parent_session_id=session["id"],
                    depth=depth,
                    metadata={
                        "tools": sorted(allowed),
                        "subagents": depth < policy.max_depth,
                        "share_sandbox_of": (session["metadata"] or {}).get("share_sandbox_of") or session["id"],
                    },
                    trigger={"type": "spawn_subagent", "parent_run_id": ctx.run_id, "call_id": ctx.call_id},
                )
                return await self._run_child(session, inv.session_id, inv.run_id, ctx, label="subagent")

        return spawn

    async def _existing_child(self, ctx: CallContext) -> dict[str, Any] | None:
        """The child run a previous attempt of this tool call started, if any (resume after a crash)."""
        rec = await self.pool.fetchrow(
            "SELECT id, session_id FROM runs WHERE trigger->>'parent_run_id' = $1 AND trigger->>'call_id' = $2 ORDER BY enqueued_at LIMIT 1",
            ctx.run_id, ctx.call_id,
        )  # fmt: skip
        return dict(rec) if rec else None

    async def _run_child(self, parent: dict[str, Any], child_session: str, child_run: str, ctx: CallContext, *, label: str) -> str:
        """Run a child session's first run inline in this worker (no slot needed, so no deadlock)."""
        await self.platform.events.append(
            Event(session_id=parent["id"], run_id=ctx.run_id, type="subagent.started", payload={"child_session_id": child_session, "agent": label})
        )
        run = await self.pool.fetchrow(
            """
            UPDATE runs SET status = 'running', worker_id = $2, attempts = attempts + 1,
                   lease_until = now() + make_interval(secs => $3), started_at = now()
            WHERE id = $1 AND (status = 'queued' OR (status = 'running' AND lease_until < now())) RETURNING *
            """,
            child_run, self.worker_id, float(self.lease_seconds),
        )  # fmt: skip
        if run is not None:
            await self.execute(dict(run))
        final = await self.platform.wait_for_run(child_run)
        await self.platform.events.append(
            Event(
                session_id=parent["id"],
                run_id=ctx.run_id,
                type="subagent.finished",
                payload={"child_session_id": child_session, "agent": label, "stop_reason": final["stop_reason"]},
            )
        )
        if final["stop_reason"] not in ("end_turn", "budget"):
            raise ToolExecutionError(f"{label} stopped with {final['stop_reason']}: {final.get('error') or ''}".strip())
        return final["output"] or "(no output)"


def _content_type(path: str) -> str | None:
    import mimetypes

    return mimetypes.guess_type(path)[0]
