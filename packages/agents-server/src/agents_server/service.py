"""Platform operations shared by the API, the scheduler and workers."""

from __future__ import annotations

import io
import secrets as pysecrets
import tarfile
from dataclasses import dataclass
from typing import Any

import asyncpg

from agents.events import Event, new_id
from agents.skills import Skill
from agents.spec import AgentSpec
from agents.types import Message

from .blobs import BlobStore
from .queue import RunQueue
from .registry import Registry, audit
from .router import Route, RouteError, Router
from .secrets import SecretStore
from .stores import PostgresEventLog, PostgresStepStore


class PolicyError(PermissionError):
    pass


class NotFound(LookupError):
    pass


class Conflict(RuntimeError):
    pass


@dataclass
class Invocation:
    session_id: str
    run_id: str
    route: Route


class Platform:
    def __init__(
        self,
        pool: asyncpg.Pool,
        *,
        registry: Registry,
        router: Router,
        queue: RunQueue,
        events: PostgresEventLog,
        steps: PostgresStepStore,
        secrets: SecretStore | None,
        blobs: BlobStore,
        max_call_depth: int = 3,
    ) -> None:
        self.pool = pool
        self.registry = registry
        self.router = router
        self.queue = queue
        self.events = events
        self.steps = steps
        self.secrets = secrets
        self.blobs = blobs
        self.max_call_depth = max_call_depth

    # -- projects and policy ------------------------------------------------

    async def policy(self, project_id: str) -> dict[str, Any]:
        return await self.pool.fetchval("SELECT policy FROM projects WHERE id = $1", project_id) or {}

    async def set_policy(self, project_id: str, policy: dict[str, Any], actor: str) -> None:
        await self.pool.execute("UPDATE projects SET policy = $2 WHERE id = $1", project_id, policy)
        await audit(self.pool, project_id, actor, "project.policy", project_id, policy)

    async def check_budget(self, project_id: str, deployment: dict[str, Any] | None) -> None:
        """Refuse new runs once a project or deployment has used its token budget."""
        policy = await self.policy(project_id)
        limits = [("project", policy.get("budget", {}), "project_id", project_id)]
        if deployment:
            limits.append(("deployment", deployment.get("budget") or {}, "deployment_id", deployment["id"]))
        for label, budget, column, value in limits:
            max_tokens = budget.get("max_tokens")
            if not max_tokens:
                continue
            window = budget.get("window", "30 days")
            used = await self.pool.fetchval(
                f"SELECT coalesce(sum(input_tokens + output_tokens), 0) FROM usage_records WHERE {column} = $1 AND at > now() - $2::interval",
                value, window,
            )  # fmt: skip
            if used >= max_tokens:
                raise PolicyError(f"{label} token budget exhausted ({used}/{max_tokens} in {window})")

    @staticmethod
    def check_agent_allowed(policy: dict[str, Any], agent: str, *, caller: str | None = None) -> None:
        allowed = policy.get("allowed_agents")
        if allowed is not None and agent not in allowed:
            raise PolicyError(f"agent {agent!r} may not be invoked in this project")
        if caller is not None:
            calls = policy.get("agent_calls", {})
            if caller in calls and agent not in calls[caller]:
                raise PolicyError(f"agent {caller!r} may not call {agent!r}")

    # -- sessions and runs ----------------------------------------------------

    async def invoke(
        self,
        project_id: str,
        target: str,
        input: str | list[Message],
        *,
        actor: str,
        deployment: dict[str, Any] | None = None,
        trigger: dict[str, Any] | None = None,
        parent_session_id: str | None = None,
        depth: int = 0,
        metadata: dict[str, Any] | None = None,
        caller_agent: str | None = None,
    ) -> Invocation:
        """Start a session through the router and enqueue its first run."""
        if depth > self.max_call_depth:
            raise PolicyError(f"agent call depth limit ({self.max_call_depth}) reached")
        policy = await self.policy(project_id)
        name = target.split("@", 1)[0]
        self.check_agent_allowed(policy, name, caller=caller_agent)
        await self.check_budget(project_id, deployment)
        session_id = new_id("ses")
        route = await self.router.resolve(project_id, target, session_id)
        version = await self.registry.get_version(project_id, route.agent, route.version)
        assert version is not None
        messages = [Message.user(input)] if isinstance(input, str) else input
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                INSERT INTO sessions (id, project_id, deployment_id, agent, alias, version, parent_session_id, depth, metadata, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                """,
                session_id, project_id, deployment["id"] if deployment else None, route.agent, route.alias, route.version,
                parent_session_id, depth, metadata or {}, actor,
            )  # fmt: skip
            run_id = await self.queue.enqueue(
                conn,
                session_id=session_id,
                project_id=project_id,
                input=[m.model_dump(mode="json") for m in messages],
                trigger=trigger,
            )
        models = version["spec"]["models"]
        await self.events.append(
            Event(
                session_id=session_id,
                run_id=run_id,
                type="route.resolved",
                model=models[0],
                payload={"agent": route.agent, "alias": route.alias, "version": route.version, "model": models[0]},
            )
        )
        await self.set_status(session_id, "queued", run_id=run_id)
        return Invocation(session_id, run_id, route)

    async def set_status(self, session_id: str, status: str, *, run_id: str | None = None, **extra: Any) -> None:
        await self.pool.execute(
            "UPDATE sessions SET status = $2, updated_at = now(), last_active_at = now() WHERE id = $1", session_id, status
        )
        await self.events.append(
            Event(session_id=session_id, run_id=run_id, type="session.status", payload={"status": status, **extra})
        )

    async def session(self, project_id: str, session_id: str) -> dict[str, Any]:
        rec = await self.pool.fetchrow("SELECT * FROM sessions WHERE id = $1 AND project_id = $2", session_id, project_id)
        if rec is None:
            raise NotFound(f"no session {session_id}")
        return dict(rec)

    async def list_sessions(self, project_id: str, *, agent: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        recs = await self.pool.fetch(
            """
            SELECT id, agent, alias, version, status, deployment_id, parent_session_id, created_at, last_active_at
            FROM sessions WHERE project_id = $1 AND ($2::text IS NULL OR agent = $2) ORDER BY created_at DESC LIMIT $3
            """,
            project_id, agent, limit,
        )  # fmt: skip
        return [dict(r) for r in recs]

    async def send_input(self, project_id: str, session_id: str, text: str, actor: str) -> dict[str, Any]:
        """Steer the running run, or start a new run on an idle session."""
        session = await self.session(project_id, session_id)
        if session["status"] == "terminated":
            raise Conflict("session is terminated")
        message = Message.user(text).model_dump(mode="json")
        active = await self.queue.active_run(session_id)
        if active and active["status"] in ("queued", "running"):
            await self.pool.execute(
                "INSERT INTO steering (session_id, run_id, message) VALUES ($1, $2, $3)", session_id, active["id"], message
            )
            return {"run_id": active["id"], "steered": True}
        if active and active["status"] == "waiting":
            raise Conflict("the session is waiting for a tool approval; decide it first")
        run_id = await self.queue.enqueue(None, session_id=session_id, project_id=project_id, input=[message], trigger={"type": "input", "actor": actor})
        await self.set_status(session_id, "queued", run_id=run_id)
        return {"run_id": run_id, "steered": False}

    async def decide_approval(
        self, project_id: str, session_id: str, call_id: str, approved: bool, reason: str | None, actor: str
    ) -> dict[str, Any]:
        await self.session(project_id, session_id)
        rec = await self.pool.fetchrow(
            """
            SELECT s.id, s.run_id, s.status FROM steps s JOIN runs r ON r.id = s.run_id
            WHERE s.session_id = $1 AND s.key = $2 ORDER BY s.seq DESC LIMIT 1
            """,
            session_id, f"approval:{call_id}",
        )  # fmt: skip
        if rec is None:
            raise NotFound(f"no approval requested for call {call_id}")
        if rec["status"] == "completed":
            raise Conflict("this call was already decided")
        await self.steps.complete(rec["id"], {"approved": approved, "reason": reason, "actor": actor})
        await self.events.append(
            Event(
                session_id=session_id,
                run_id=rec["run_id"],
                type="tool.approval.decided",
                payload={"call_id": call_id, "approved": approved, "reason": reason, "actor": actor},
            )
        )
        await audit(self.pool, project_id, actor, "tool.approval", f"{session_id}/{call_id}", {"approved": approved})
        undecided = await self.pool.fetchval(
            "SELECT count(*) FROM steps WHERE run_id = $1 AND type = 'approval' AND status <> 'completed'", rec["run_id"]
        )
        if undecided == 0:
            await self.queue.requeue_waiting(rec["run_id"])
            await self.set_status(session_id, "queued", run_id=rec["run_id"])
        return {"run_id": rec["run_id"], "resumed": undecided == 0}

    async def interrupt(self, project_id: str, session_id: str, actor: str) -> dict[str, Any]:
        await self.session(project_id, session_id)
        active = await self.queue.active_run(session_id)
        if active is None:
            return {"interrupted": False}
        await self.queue.request_cancel(active["id"])
        if active["status"] in ("queued", "waiting"):
            await self.events.append(
                Event(session_id=session_id, run_id=active["id"], type="run.finished", payload={"stop_reason": "interrupted"})
            )
            await self.set_status(session_id, "idle", run_id=active["id"], stop_reason="interrupted")
        return {"interrupted": True, "run_id": active["id"]}

    async def terminate(self, project_id: str, session_id: str, actor: str) -> None:
        await self.interrupt(project_id, session_id, actor)
        await self.pool.execute("UPDATE sessions SET sandbox_state = CASE WHEN sandbox IS NULL THEN 'none' ELSE 'destroyed' END WHERE id = $1 AND sandbox_state <> 'none'", session_id)
        await self.set_status(session_id, "terminated")

    async def wait_for_run(self, run_id: str, timeout: float = 600) -> dict[str, Any]:
        """Wait until a run is no longer queued or running (used by sync invoke and call_agent)."""
        import asyncio

        deadline = asyncio.get_running_loop().time() + timeout
        delay = 0.05
        while True:
            rec = await self.pool.fetchrow("SELECT * FROM runs WHERE id = $1", run_id)
            if rec and rec["status"] in ("finished", "waiting", "cancelled"):
                return dict(rec)
            if asyncio.get_running_loop().time() > deadline:
                raise TimeoutError(f"run {run_id} did not finish within {timeout}s")
            await asyncio.sleep(delay)
            delay = min(delay * 1.5, 1.0)

    # -- deployments -------------------------------------------------------------

    async def create_deployment(self, project_id: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        from .triggers import validate_triggers

        agent, alias = data["agent"], data.get("alias", "prod")
        if data.get("version") is not None:
            await self.registry.set_alias(project_id, agent, alias, {"versions": [{"version": int(data["version"]), "weight": 100}]}, actor)
        elif await self.registry.get_alias(project_id, agent, alias) is None:
            raise RouteError(f"{agent} has no alias {alias!r}; pass a version to create it")
        triggers = validate_triggers(data.get("triggers") or [{"type": "http"}])
        dep_id = new_id("dep")
        name = data.get("name") or f"{agent}-{alias}"
        try:
            rec = await self.pool.fetchrow(
                """
                INSERT INTO deployments (id, project_id, name, agent, alias, triggers, concurrency, environment, secrets, budget, webhook_secret, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
                """,
                dep_id, project_id, name, agent, alias, triggers, int(data.get("concurrency", 10)), data.get("environment"),
                list(data.get("secrets") or []), data.get("budget") or {}, data.get("webhook_secret") or pysecrets.token_urlsafe(32), actor,
            )  # fmt: skip
        except asyncpg.UniqueViolationError:
            raise Conflict(f"a deployment named {name!r} already exists") from None
        await audit(self.pool, project_id, actor, "deployment.create", name, {"agent": agent, "alias": alias})
        return dict(rec)

    async def deployment(self, project_id: str, ref: str) -> dict[str, Any]:
        rec = await self.pool.fetchrow(
            "SELECT * FROM deployments WHERE project_id = $1 AND (id = $2 OR name = $2) AND status <> 'deleted'", project_id, ref
        )
        if rec is None:
            raise NotFound(f"no deployment {ref}")
        return dict(rec)

    async def deployment_by_id(self, dep_id: str) -> dict[str, Any] | None:
        rec = await self.pool.fetchrow("SELECT * FROM deployments WHERE (id = $1 OR name = $1) AND status <> 'deleted'", dep_id)
        return dict(rec) if rec else None

    async def list_deployments(self, project_id: str) -> list[dict[str, Any]]:
        recs = await self.pool.fetch(
            "SELECT * FROM deployments WHERE project_id = $1 AND status <> 'deleted' ORDER BY created_at", project_id
        )
        return [dict(r) for r in recs]

    async def update_deployment(self, project_id: str, ref: str, changes: dict[str, Any], actor: str) -> dict[str, Any]:
        from .triggers import validate_triggers

        dep = await self.deployment(project_id, ref)
        fields: dict[str, Any] = {}
        if "status" in changes:
            if changes["status"] not in ("active", "paused", "deleted"):
                raise ValueError("status must be active, paused or deleted")
            fields["status"] = changes["status"]
        if "triggers" in changes:
            fields["triggers"] = validate_triggers(changes["triggers"])
            await self.pool.execute("DELETE FROM cron_state WHERE deployment_id = $1", dep["id"])
        for key in ("concurrency", "environment", "secrets", "budget"):
            if key in changes:
                fields[key] = changes[key]
        if "version" in changes:
            await self.registry.set_alias(project_id, dep["agent"], dep["alias"], {"versions": [{"version": int(changes["version"]), "weight": 100}]}, actor)
        if fields:
            sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(fields))
            await self.pool.execute(f"UPDATE deployments SET {sets}, updated_at = now() WHERE id = $1", dep["id"], *fields.values())
        await audit(self.pool, project_id, actor, "deployment.update", dep["name"], {k: v for k, v in changes.items() if k != "webhook_secret"})
        return await self.deployment(project_id, dep["id"]) if fields.get("status") != "deleted" else {**dep, "status": "deleted"}

    async def running_sessions(self, deployment_id: str) -> int:
        return int(
            await self.pool.fetchval(
                "SELECT count(DISTINCT r.session_id) FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.deployment_id = $1 AND r.status IN ('queued', 'running')",
                deployment_id,
            )
        )

    # -- environments, skills, artifacts ------------------------------------------

    async def put_environment(self, project_id: str, name: str, spec: dict[str, Any], actor: str) -> dict[str, Any]:
        from agents.sandbox.base import Environment

        env = Environment.model_validate({**spec, "name": name})
        await self.pool.execute(
            """
            INSERT INTO environments (project_id, name, spec) VALUES ($1, $2, $3)
            ON CONFLICT (project_id, name) DO UPDATE SET spec = EXCLUDED.spec, updated_at = now()
            """,
            project_id, name, env.model_dump(mode="json"),
        )  # fmt: skip
        await audit(self.pool, project_id, actor, "environment.put", name)
        return env.model_dump(mode="json")

    async def environment(self, project_id: str, name: str | None) -> dict[str, Any] | None:
        if not name:
            return None
        return await self.pool.fetchval("SELECT spec FROM environments WHERE project_id = $1 AND name = $2", project_id, name)

    async def list_environments(self, project_id: str) -> list[dict[str, Any]]:
        return [r["spec"] for r in await self.pool.fetch("SELECT spec FROM environments WHERE project_id = $1 ORDER BY name", project_id)]

    async def upload_skill(self, project_id: str, bundle: bytes, actor: str) -> dict[str, Any]:
        """Register a skill from a .tar.gz of its folder (SKILL.md at the root)."""
        files: dict[str, bytes] = {}
        with tarfile.open(fileobj=io.BytesIO(bundle), mode="r:*") as tar:
            for member in tar.getmembers():
                if not member.isfile():
                    continue
                path = member.name.lstrip("./")
                if path.startswith("/") or ".." in path.split("/"):
                    raise ValueError(f"unsafe path in skill bundle: {member.name}")
                f = tar.extractfile(member)
                if f is not None:
                    files[path] = f.read()
        if "SKILL.md" not in files:
            raise ValueError("skill bundle must contain SKILL.md at its root")
        from agents.skills import parse_front_matter

        meta = parse_front_matter(files["SKILL.md"].decode())
        if not meta.get("name"):
            raise ValueError("SKILL.md front matter needs a name")
        skill = Skill(meta["name"], meta.get("description", ""), files)
        key = f"skills/{project_id}/{skill.name}/{skill.version}.tar.gz"
        await self.blobs.put(key, bundle, "application/gzip")
        await self.pool.execute(
            """
            INSERT INTO skills (project_id, name, version, description, bundle_key, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (project_id, name, version) DO NOTHING
            """,
            project_id, skill.name, skill.version, skill.description, key, len(bundle),
        )  # fmt: skip
        await audit(self.pool, project_id, actor, "skill.upload", f"{skill.name}@{skill.version}")
        return {"name": skill.name, "version": skill.version, "description": skill.description}

    async def load_skill(self, project_id: str, name: str, version: str) -> Skill:
        rec = await self.pool.fetchrow(
            "SELECT bundle_key, description FROM skills WHERE project_id = $1 AND name = $2 AND version = $3", project_id, name, version
        )
        if rec is None:
            raise NotFound(f"skill {name}@{version}")
        data = await self.blobs.get(rec["bundle_key"])
        files: dict[str, bytes] = {}
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tar:
            for member in tar.getmembers():
                f = tar.extractfile(member) if member.isfile() else None
                if f is not None:
                    files[member.name.lstrip("./")] = f.read()
        return Skill(name, rec["description"], files)

    async def list_artifacts(self, project_id: str, session_id: str) -> list[dict[str, Any]]:
        await self.session(project_id, session_id)
        recs = await self.pool.fetch(
            "SELECT id, path, size_bytes, content_type, run_id, created_at FROM artifacts WHERE session_id = $1 ORDER BY path", session_id
        )
        return [dict(r) for r in recs]

    async def artifact(self, project_id: str, session_id: str, artifact_id: str) -> tuple[dict[str, Any], bytes]:
        await self.session(project_id, session_id)
        rec = await self.pool.fetchrow("SELECT * FROM artifacts WHERE session_id = $1 AND id = $2", session_id, artifact_id)
        if rec is None:
            raise NotFound(f"no artifact {artifact_id}")
        return dict(rec), await self.blobs.get(rec["object_key"])

    async def spec_for(self, project_id: str, agent: str, version: int) -> AgentSpec:
        rec = await self.registry.get_version(project_id, agent, version)
        if rec is None:
            raise NotFound(f"{agent}@{version}")
        return AgentSpec.model_validate(rec["spec"])

    async def usage(self, project_id: str, *, days: int = 30) -> list[dict[str, Any]]:
        recs = await self.pool.fetch(
            """
            SELECT date_trunc('day', at) AS day, model, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
                   sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens,
                   sum(sandbox_seconds) AS sandbox_seconds, sum(tool_calls) AS tool_calls, count(*) AS runs
            FROM usage_records WHERE project_id = $1 AND at > now() - make_interval(days => $2)
            GROUP BY 1, 2 ORDER BY 1, 2
            """,
            project_id, days,
        )  # fmt: skip
        return [dict(r) for r in recs]
