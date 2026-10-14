"""The Postgres run queue (ADR-0005).

Runs are claimed with ``FOR UPDATE SKIP LOCKED``. The claiming worker holds a
lease and heartbeats it; when a lease expires (the worker died), any worker
may claim the run again and resume it from its last completed step.
"""

from __future__ import annotations

from typing import Any

import asyncpg

from agents.events import new_id

RUN_CHANNEL = "agents_runs"


class RunQueue:
    def __init__(self, pool: asyncpg.Pool, *, lease_seconds: int = 30) -> None:
        self.pool = pool
        self.lease_seconds = lease_seconds

    async def enqueue(
        self,
        conn: asyncpg.Connection | asyncpg.Pool | None,
        *,
        session_id: str,
        project_id: str,
        input: list[dict[str, Any]],
        trigger: dict[str, Any] | None = None,
        run_id: str | None = None,
    ) -> str:
        db = conn or self.pool
        rid = run_id or new_id("run")
        await db.execute(
            "INSERT INTO runs (id, session_id, project_id, input, trigger) VALUES ($1, $2, $3, $4, $5)",
            rid, session_id, project_id, input, trigger or {},
        )  # fmt: skip
        await db.execute("SELECT pg_notify($1, $2)", RUN_CHANNEL, rid)
        return rid

    async def claim(self, worker_id: str) -> dict[str, Any] | None:
        """Lease the oldest runnable run: queued, or running with an expired lease.

        A session runs at most one run at a time; later runs wait their turn.
        """
        rec = await self.pool.fetchrow(
            """
            UPDATE runs SET status = 'running', worker_id = $1, attempts = attempts + 1,
                   lease_until = now() + make_interval(secs => $2), started_at = coalesce(started_at, now())
            WHERE id = (
                SELECT r.id FROM runs r
                WHERE (r.status = 'queued' OR (r.status = 'running' AND r.lease_until < now()))
                  AND NOT EXISTS (
                      SELECT 1 FROM runs o
                      WHERE o.session_id = r.session_id AND o.id <> r.id
                        AND ((o.status = 'running' AND o.lease_until >= now())
                             OR (o.status IN ('queued', 'running', 'waiting') AND o.enqueued_at < r.enqueued_at))
                  )
                ORDER BY r.enqueued_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING *
            """,
            worker_id, float(self.lease_seconds),
        )  # fmt: skip
        return dict(rec) if rec else None

    async def heartbeat(self, run_id: str, worker_id: str) -> bool:
        """Extend the lease; False means the run was taken over or cancelled."""
        rec = await self.pool.fetchrow(
            """
            UPDATE runs SET lease_until = now() + make_interval(secs => $3)
            WHERE id = $1 AND worker_id = $2 AND status = 'running'
            RETURNING cancel_requested
            """,
            run_id, worker_id, float(self.lease_seconds),
        )  # fmt: skip
        return rec is not None and not rec["cancel_requested"]

    async def finish(
        self,
        run_id: str,
        worker_id: str,
        *,
        status: str,
        stop_reason: str,
        usage: dict[str, Any],
        output: str | None,
        error: str | None,
        model: str | None,
    ) -> bool:
        res = await self.pool.execute(
            """
            UPDATE runs SET status = $3, stop_reason = $4, usage = $5, output = $6, error = $7, model = $8,
                   lease_until = NULL, finished_at = CASE WHEN $3 = 'finished' THEN now() ELSE NULL END
            WHERE id = $1 AND worker_id = $2
            """,
            run_id, worker_id, status, stop_reason, usage, output, error, model,
        )  # fmt: skip
        return res.endswith("1")

    async def release(self, run_id: str, worker_id: str) -> None:
        """Hand a run back to the queue (graceful worker shutdown)."""
        await self.pool.execute(
            "UPDATE runs SET status = 'queued', worker_id = NULL, lease_until = NULL WHERE id = $1 AND worker_id = $2",
            run_id, worker_id,
        )  # fmt: skip

    async def requeue_waiting(self, run_id: str) -> None:
        """A waiting run (approval pending) becomes runnable again."""
        await self.pool.execute(
            "UPDATE runs SET status = 'queued', worker_id = NULL, enqueued_at = enqueued_at WHERE id = $1 AND status = 'waiting'",
            run_id,
        )
        await self.pool.execute("SELECT pg_notify($1, $2)", RUN_CHANNEL, run_id)

    async def request_cancel(self, run_id: str) -> None:
        await self.pool.execute(
            """
            UPDATE runs SET cancel_requested = true,
                   status = CASE WHEN status IN ('queued', 'waiting') THEN 'cancelled' ELSE status END,
                   finished_at = CASE WHEN status IN ('queued', 'waiting') THEN now() ELSE finished_at END
            WHERE id = $1 AND status IN ('queued', 'running', 'waiting')
            """,
            run_id,
        )

    async def depth(self) -> int:
        return int(await self.pool.fetchval("SELECT count(*) FROM runs WHERE status = 'queued'"))

    async def active_run(self, session_id: str) -> dict[str, Any] | None:
        rec = await self.pool.fetchrow(
            "SELECT * FROM runs WHERE session_id = $1 AND status IN ('queued', 'running', 'waiting') ORDER BY enqueued_at DESC LIMIT 1",
            session_id,
        )
        return dict(rec) if rec else None
