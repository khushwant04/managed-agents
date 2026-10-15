"""API keys and the tenant model: ``org → project → API key`` with RBAC roles.

Keys look like ``ak_<prefix>_<secret>``; only a SHA-256 hash is stored.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from typing import Literal

import asyncpg

from runhive.events import new_id

Role = Literal["admin", "developer", "viewer"]
_RANK = {"viewer": 0, "developer": 1, "admin": 2}


@dataclass(frozen=True)
class Principal:
    project_id: str
    key_id: str
    role: Role

    @property
    def actor(self) -> str:
        return f"key:{self.key_id}"

    def can(self, role: Role) -> bool:
        return _RANK[self.role] >= _RANK[role]


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def generate_key() -> tuple[str, str]:
    prefix = secrets.token_hex(4)
    return f"ak_{prefix}_{secrets.token_urlsafe(32)}", prefix


async def create_org_project(pool: asyncpg.Pool, org: str, project: str) -> tuple[str, str]:
    org_id, project_id = new_id("org"), new_id("prj")
    async with pool.acquire() as conn, conn.transaction():
        existing = await conn.fetchrow(
            "SELECT o.id AS org_id, p.id AS project_id FROM orgs o JOIN projects p ON p.org_id = o.id WHERE o.name = $1 AND p.name = $2",
            org, project,
        )  # fmt: skip
        if existing:
            return existing["org_id"], existing["project_id"]
        org_row = await conn.fetchrow("SELECT id FROM orgs WHERE name = $1", org)
        if org_row:
            org_id = org_row["id"]
        else:
            await conn.execute("INSERT INTO orgs (id, name) VALUES ($1, $2)", org_id, org)
        await conn.execute("INSERT INTO projects (id, org_id, name) VALUES ($1, $2, $3)", project_id, org_id, project)
    return org_id, project_id


async def create_key(pool: asyncpg.Pool, project_id: str, name: str, role: Role, key: str | None = None) -> tuple[str, str]:
    """Create an API key; returns (key_id, plaintext key). The plaintext is never stored."""
    if key is None:
        key, prefix = generate_key()
    else:
        prefix = key.split("_")[1] if key.startswith("ak_") and key.count("_") >= 2 else key[:8]
    key_id = new_id("key")
    await pool.execute(
        "INSERT INTO api_keys (id, project_id, name, prefix, hash, role) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (hash) DO NOTHING",
        key_id, project_id, name, prefix, hash_key(key), role,
    )  # fmt: skip
    return key_id, key


async def authenticate(pool: asyncpg.Pool, key: str) -> Principal | None:
    rec = await pool.fetchrow(
        "UPDATE api_keys SET last_used_at = now() WHERE hash = $1 AND revoked_at IS NULL RETURNING id, project_id, role",
        hash_key(key),
    )
    return Principal(project_id=rec["project_id"], key_id=rec["id"], role=rec["role"]) if rec else None


async def bootstrap(pool: asyncpg.Pool, admin_key: str, org: str = "default", project: str = "default") -> str:
    _, project_id = await create_org_project(pool, org, project)
    await create_key(pool, project_id, "bootstrap", "admin", admin_key)
    return project_id
