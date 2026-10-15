"""Postgres access: a connection pool, JSON codecs and the migration runner."""

from __future__ import annotations

import json
from importlib import resources
from typing import Any

import asyncpg


async def _init_connection(conn: asyncpg.Connection) -> None:
    for typ in ("json", "jsonb"):
        await conn.set_type_codec(typ, encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def create_pool(dsn: str, *, min_size: int = 1, max_size: int = 10) -> asyncpg.Pool:
    pool = await asyncpg.create_pool(dsn, min_size=min_size, max_size=max_size, init=_init_connection)
    assert pool is not None
    return pool


async def migrate(pool: asyncpg.Pool) -> list[str]:
    """Apply pending SQL migrations in order; return the names applied."""
    files = sorted(
        (f for f in resources.files("runhive_server.migrations").iterdir() if f.name.endswith(".sql")),
        key=lambda f: f.name,
    )
    applied: list[str] = []
    async with pool.acquire() as conn:
        await conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
        )
        # One migrator at a time across processes.
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(727274)")
            done = {r["name"] for r in await conn.fetch("SELECT name FROM schema_migrations")}
            for f in files:
                if f.name in done:
                    continue
                await conn.execute(f.read_text())
                await conn.execute("INSERT INTO schema_migrations (name) VALUES ($1)", f.name)
                applied.append(f.name)
    return applied


def row(record: asyncpg.Record | None) -> dict[str, Any] | None:
    return dict(record) if record is not None else None
