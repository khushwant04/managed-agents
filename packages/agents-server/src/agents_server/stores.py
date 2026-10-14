"""Postgres implementations of the runtime's durable stores (ADR-0005, ADR-0008)."""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from collections.abc import AsyncIterator
from typing import Any

import asyncpg

from agents.events import Event, new_id
from agents.runtime.runner import SteeringQueue
from agents.store.base import Step, StepSpec
from agents.types import Message

EVENTS_CHANNEL = "agents_events"


class PostgresStepStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    async def begin(self, step: StepSpec) -> str:
        sid = new_id("step")
        rec = await self.pool.fetchrow(
            """
            INSERT INTO steps (id, session_id, run_id, key, type, input)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (run_id, key) DO UPDATE
              SET attempts = steps.attempts + CASE WHEN steps.status = 'completed' THEN 0 ELSE 1 END,
                  status = CASE WHEN steps.status = 'completed' THEN 'completed' ELSE 'begun' END
            RETURNING id
            """,
            sid, step.session_id, step.run_id, step.key, step.type, step.input,
        )  # fmt: skip
        return rec["id"]

    async def complete(self, step_id: str, output: dict[str, Any]) -> None:
        await self.pool.execute(
            "UPDATE steps SET status = 'completed', output = $2, completed_at = now() WHERE id = $1", step_id, output
        )

    async def fail(self, step_id: str, error: str) -> None:
        await self.pool.execute("UPDATE steps SET status = 'failed', error = $2 WHERE id = $1", step_id, error)

    async def get(self, run_id: str, key: str) -> Step | None:
        rec = await self.pool.fetchrow("SELECT * FROM steps WHERE run_id = $1 AND key = $2", run_id, key)
        return Step.model_validate(dict(rec)) if rec else None

    async def last_completed(self, run_id: str) -> Step | None:
        rec = await self.pool.fetchrow(
            "SELECT * FROM steps WHERE run_id = $1 AND status = 'completed' ORDER BY seq DESC LIMIT 1", run_id
        )
        return Step.model_validate(dict(rec)) if rec else None

    async def session_steps(self, session_id: str) -> list[Step]:
        recs = await self.pool.fetch(
            "SELECT * FROM steps WHERE session_id = $1 AND status = 'completed' ORDER BY seq", session_id
        )
        return [Step.model_validate(dict(r)) for r in recs]


class PostgresEventLog:
    """Appends events with a per-session ``seq`` and fans them out with NOTIFY.

    ``subscribe`` replays from the table, then follows live events through a
    shared ``StreamHub`` (one LISTEN connection per process).
    """

    def __init__(self, pool: asyncpg.Pool, hub: StreamHub | None = None) -> None:
        self.pool = pool
        self.hub = hub

    async def append(self, event: Event) -> Event:
        async with self.pool.acquire() as conn, conn.transaction():
            seq = await conn.fetchval(
                "UPDATE sessions SET last_seq = last_seq + 1, updated_at = now() WHERE id = $1 RETURNING last_seq",
                event.session_id,
            )
            if seq is None:
                raise KeyError(f"unknown session {event.session_id}")
            event = event.model_copy(update={"seq": seq})
            await conn.execute(
                "INSERT INTO events (id, session_id, run_id, seq, type, ts, model, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
                event.id, event.session_id, event.run_id, seq, event.type, event.ts, event.model, event.payload,
            )  # fmt: skip
            await conn.execute("SELECT pg_notify($1, $2)", EVENTS_CHANNEL, f"{event.session_id}:{seq}")
        return event

    async def read(self, session_id: str, after_seq: int = 0, limit: int | None = None) -> list[Event]:
        recs = await self.pool.fetch(
            "SELECT * FROM events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
            session_id, after_seq, limit or 100_000,
        )  # fmt: skip
        return [_event(r) for r in recs]

    async def subscribe(self, session_id: str, after_seq: int = 0) -> AsyncIterator[Event]:
        if self.hub is None:
            raise RuntimeError("PostgresEventLog.subscribe needs a StreamHub")
        seq = after_seq
        with self.hub.watch(session_id) as wake:
            while True:
                for ev in await self.read(session_id, seq, 500):
                    seq = ev.seq
                    yield ev
                await wake.wait()
                wake.clear()


def _event(rec: asyncpg.Record) -> Event:
    d = dict(rec)
    if isinstance(d.get("payload"), str):
        d["payload"] = json.loads(d["payload"])
    return Event.model_validate(d)


class _Watch:
    def __init__(self, hub: StreamHub, session_id: str) -> None:
        self.hub, self.session_id = hub, session_id
        self.event = asyncio.Event()

    def __enter__(self) -> asyncio.Event:
        self.hub._watchers[self.session_id].add(self.event)
        self.event.set()  # read once immediately
        return self.event

    def __exit__(self, *exc: object) -> None:
        self.hub._watchers[self.session_id].discard(self.event)


class StreamHub:
    """One LISTEN connection per process, waking local subscribers per session."""

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self._conn: asyncpg.Connection | None = None
        self._watchers: dict[str, set[asyncio.Event]] = defaultdict(set)
        self._callbacks: dict[str, list[Any]] = defaultdict(list)

    async def start(self) -> None:
        self._conn = await asyncpg.connect(self.dsn)
        await self._conn.add_listener(EVENTS_CHANNEL, self._on_event)

    async def listen(self, channel: str, callback: Any) -> None:
        """Subscribe a callback ``(payload: str) -> None`` to another channel."""
        assert self._conn is not None
        self._callbacks[channel].append(callback)
        if len(self._callbacks[channel]) == 1:
            await self._conn.add_listener(channel, lambda *a: [cb(a[3]) for cb in self._callbacks[channel]])

    def _on_event(self, _conn: Any, _pid: int, _channel: str, payload: str) -> None:
        session_id = payload.rsplit(":", 1)[0]
        for ev in self._watchers.get(session_id, ()):
            ev.set()

    def watch(self, session_id: str) -> _Watch:
        return _Watch(self, session_id)

    async def stop(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None


class PostgresSteeringQueue(SteeringQueue):
    """Mid-run input stored in ``steering`` rows, consumed at step boundaries."""

    def __init__(self, pool: asyncpg.Pool, run_id: str) -> None:
        super().__init__()
        self.pool = pool
        self.run_id = run_id

    async def take(self) -> list[Message]:
        recs = await self.pool.fetch(
            """
            UPDATE steering SET consumed_at = now()
            WHERE id IN (SELECT id FROM steering WHERE run_id = $1 AND consumed_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED)
            RETURNING id, message
            """,
            self.run_id,
        )
        return [Message.model_validate(r["message"]) for r in sorted(recs, key=lambda r: r["id"])]

    async def pending(self) -> bool:
        return bool(
            await self.pool.fetchval(
                "SELECT EXISTS (SELECT 1 FROM steering WHERE run_id = $1 AND consumed_at IS NULL)", self.run_id
            )
        )
