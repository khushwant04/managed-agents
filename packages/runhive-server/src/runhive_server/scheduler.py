"""The scheduler: cron triggers, the idle-sandbox reaper and partition upkeep.

Several scheduler processes may run; a Postgres advisory lock makes one the
leader at a time.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg

from runhive.sandbox import provider_for
from runhive.sandbox.base import Environment, SandboxHandle

from .service import Platform, PolicyError
from .triggers import next_cron

log = logging.getLogger("runhive.scheduler")
LEADER_LOCK = 727275


class Scheduler:
    def __init__(self, platform: Platform, *, idle_pause_seconds: int = 300, sandboxes: Any = None) -> None:
        self.platform = platform
        self.pool = platform.pool
        self.idle_pause_seconds = idle_pause_seconds
        self._sandboxes = sandboxes

    async def tick(self, now: datetime | None = None) -> dict[str, int]:
        now = now or datetime.now(UTC)
        return {
            "cron_fired": await self.fire_cron(now),
            "sandboxes_paused": await self.pause_idle(),
            "partitions_created": await self.ensure_partitions(now),
        }

    async def fire_cron(self, now: datetime) -> int:
        fired = 0
        for dep in await self.pool.fetch("SELECT * FROM deployments WHERE status = 'active'"):
            dep = dict(dep)
            for i, trigger in enumerate(dep["triggers"]):
                if trigger["type"] != "cron":
                    continue
                tz = trigger.get("timezone", "UTC")
                async with self.pool.acquire() as conn, conn.transaction():
                    state = await conn.fetchrow(
                        "SELECT * FROM cron_state WHERE deployment_id = $1 AND trigger_index = $2 FOR UPDATE", dep["id"], i
                    )
                    if state is None:
                        await conn.execute(
                            "INSERT INTO cron_state (deployment_id, trigger_index, next_run_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
                            dep["id"], i, next_cron(trigger["schedule"], now, tz),
                        )  # fmt: skip
                        continue
                    if state["next_run_at"] > now:
                        continue
                    # Fire once even if several slots were missed, then schedule the next one after now.
                    await conn.execute(
                        "UPDATE cron_state SET last_run_at = $3, next_run_at = $4 WHERE deployment_id = $1 AND trigger_index = $2",
                        dep["id"], i, now, next_cron(trigger["schedule"], now, tz),
                    )  # fmt: skip
                try:
                    await self.platform.invoke(
                        dep["project_id"],
                        f"{dep['agent']}@{dep['alias']}",
                        trigger["input"],
                        actor="scheduler",
                        deployment=dep,
                        trigger={"type": "cron", "schedule": trigger["schedule"], "slot": state["next_run_at"].isoformat()},
                    )
                    fired += 1
                except (PolicyError, LookupError) as exc:
                    log.warning("cron trigger %s/%d skipped: %s", dep["name"], i, exc)
        return fired

    async def pause_idle(self) -> int:
        """Idle sessions hold no worker; pause their sandboxes after the idle timeout."""
        recs = await self.pool.fetch(
            """
            SELECT s.* FROM sessions s
            WHERE s.sandbox_state = 'running' AND s.last_active_at < now() - make_interval(secs => $1)
              AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.session_id = s.id AND r.status IN ('queued', 'running'))
              AND NOT EXISTS (SELECT 1 FROM sessions c WHERE c.metadata->>'share_sandbox_of' = s.id
                              AND EXISTS (SELECT 1 FROM runs r2 WHERE r2.session_id = c.id AND r2.status IN ('queued', 'running')))
            LIMIT 100
            """,
            float(self.idle_pause_seconds),
        )
        paused = 0
        for rec in recs:
            handle = SandboxHandle.model_validate(rec["sandbox"])
            provider = self._provider(handle.provider)
            target = "destroyed" if rec["status"] == "terminated" else "paused"
            try:
                if target == "destroyed":
                    await provider.destroy(handle)
                else:
                    await provider.pause(handle)
            except Exception as exc:
                log.warning("could not %s sandbox %s: %s", "destroy" if target == "destroyed" else "pause", handle.id, exc)
                continue
            await self.pool.execute("UPDATE sessions SET sandbox_state = $2 WHERE id = $1 AND sandbox_state = 'running'", rec["id"], target)
            paused += 1
        return paused

    def _provider(self, name: str) -> Any:
        if self._sandboxes is not None:
            return self._sandboxes(name)
        return provider_for(Environment(provider=name))  # type: ignore[arg-type]

    async def ensure_partitions(self, now: datetime, days_ahead: int = 3) -> int:
        """Create daily ``events`` partitions ahead of time (rows before that land in the default)."""
        created = 0
        for d in range(1, days_ahead + 1):
            day = (now + timedelta(days=d)).date()
            name = f"events_{day:%Y%m%d}"
            exists = await self.pool.fetchval("SELECT to_regclass($1)", name)
            if exists:
                continue
            try:
                await self.pool.execute(
                    f"CREATE TABLE {name} PARTITION OF events FOR VALUES FROM ('{day}') TO ('{day + timedelta(days=1)}')"
                )
                created += 1
            except asyncpg.PostgresError as exc:
                log.warning("could not create partition %s: %s", name, exc)
        return created

    async def run_forever(self, stop: asyncio.Event, *, interval: float = 5.0) -> None:
        async with self.pool.acquire() as conn:
            while not stop.is_set():
                leader = await conn.fetchval("SELECT pg_try_advisory_lock($1)", LEADER_LOCK)
                if leader:
                    log.info("scheduler is leader")
                    try:
                        while not stop.is_set():
                            try:
                                stats = await self.tick()
                                if any(stats.values()):
                                    log.info("scheduler tick: %s", stats)
                            except Exception:
                                log.exception("scheduler tick failed")
                            with contextlib.suppress(TimeoutError):
                                await asyncio.wait_for(stop.wait(), interval)
                    finally:
                        await conn.execute("SELECT pg_advisory_unlock($1)", LEADER_LOCK)
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stop.wait(), interval)
