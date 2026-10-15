"""The registry: immutable, content-hashed agent versions and movable aliases (ADR-0004)."""

from __future__ import annotations

from typing import Any

import asyncpg
from pydantic import BaseModel, Field, ValidationError, model_validator

from runhive.adapters import AdapterRegistry
from runhive.adapters.base import ModelError
from runhive.spec import AgentSpec

ALIAS_CHANNEL = "runhive_aliases"


class RegistryError(ValueError):
    """A definition the registry rejects; ``problems`` lists every reason."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


class VersionWeight(BaseModel):
    version: int = Field(ge=1)
    weight: int = Field(default=100, ge=0, le=100)


class AliasTarget(BaseModel):
    versions: list[VersionWeight] = Field(min_length=1)

    @model_validator(mode="after")
    def _weights(self) -> AliasTarget:
        if sum(v.weight for v in self.versions) != 100:
            raise ValueError("alias weights must add up to 100")
        if len({v.version for v in self.versions}) != len(self.versions):
            raise ValueError("each version may appear once in an alias")
        return self


def required_features(spec: AgentSpec, vendor: str) -> set[str]:
    """Capability-manifest fields an agent needs from a model of this vendor."""
    needs: set[str] = set()
    if spec.tools:
        needs.add("tools")
    if spec.reasoning:
        needs.add("reasoning")
    if spec.model_options.get(vendor, {}).get("compaction"):
        needs.add("native_compaction")
    return needs


class Registry:
    def __init__(self, pool: asyncpg.Pool, adapters: AdapterRegistry | None = None) -> None:
        self.pool = pool
        self.adapters = adapters or AdapterRegistry()

    async def validate(self, project_id: str, spec: AgentSpec, policy: dict[str, Any] | None = None) -> list[str]:
        problems: list[str] = []
        policy = policy or {}
        allowed_models = policy.get("allowed_models")
        for model in spec.models:
            if allowed_models is not None and model not in allowed_models:
                problems.append(f"model {model!r} is not allowed in this project")
            try:
                adapter, name = self.adapters.resolve(model)
            except ModelError as exc:
                problems.append(str(exc))
                continue
            manifest = adapter.capabilities(name)
            missing = manifest.missing(required_features(spec, adapter.id))
            if missing:
                problems.append(f"model {model!r} cannot serve: {', '.join(sorted(missing))}")
        allowed_tools = policy.get("allowed_tools")
        for ref in spec.tools:
            if allowed_tools is not None and ref.name not in allowed_tools and ref.type != "agent":
                problems.append(f"tool {ref.name!r} is not allowed in this project")
            if ref.type == "function" and not ref.url and not ref.options.get("script"):
                problems.append(
                    f"function tool {ref.name!r} needs a webhook url (or a sandbox script) to run hosted"
                )
            if ref.type == "mcp" and not ref.url:
                problems.append(f"MCP tool {ref.name!r} needs a url")
            if ref.type == "agent":
                target = str(ref.options.get("agent", "")).split("@", 1)[0]
                if target == spec.name:
                    continue  # an agent may call itself (bounded by the depth limit)
                exists = await self.pool.fetchval(
                    "SELECT 1 FROM agents WHERE project_id = $1 AND name = $2", project_id, target
                )
                if not exists:
                    problems.append(f"agent tool {ref.name!r} refers to unknown agent {target!r}")
        for skill in spec.skills:
            if not skill.version:
                problems.append(f"skill {skill.name!r} has no version; upload it with POST /v1/skills")
                continue
            exists = await self.pool.fetchval(
                "SELECT 1 FROM skills WHERE project_id = $1 AND name = $2 AND version = $3",
                project_id, skill.name, skill.version,
            )  # fmt: skip
            if not exists:
                problems.append(f"skill {skill.name}@{skill.version} is not registered")
        return problems

    async def register(
        self, project_id: str, data: dict[str, Any] | AgentSpec, actor: str, policy: dict[str, Any] | None = None
    ) -> tuple[dict[str, Any], bool]:
        """Register a definition. Returns (version row, created); identical definitions are a no-op."""
        try:
            spec = data if isinstance(data, AgentSpec) else AgentSpec.model_validate(data)
        except ValidationError as exc:
            raise RegistryError([f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()]) from None
        problems = await self.validate(project_id, spec, policy)
        if problems:
            raise RegistryError(problems)
        digest = spec.content_hash()
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                INSERT INTO agents (project_id, name, description, tags, created_by) VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (project_id, name) DO UPDATE SET description = EXCLUDED.description, tags = EXCLUDED.tags
                """,
                project_id, spec.name, spec.description, spec.tags, actor,
            )  # fmt: skip
            # Serialize version numbering per agent.
            await conn.execute("SELECT 1 FROM agents WHERE project_id = $1 AND name = $2 FOR UPDATE", project_id, spec.name)
            existing = await conn.fetchrow(
                "SELECT * FROM agent_versions WHERE project_id = $1 AND name = $2 AND hash = $3", project_id, spec.name, digest
            )
            if existing:
                return dict(existing), False
            version = await conn.fetchval(
                "SELECT coalesce(max(version), 0) + 1 FROM agent_versions WHERE project_id = $1 AND name = $2",
                project_id, spec.name,
            )  # fmt: skip
            card = spec.card(version=version)
            rec = await conn.fetchrow(
                """
                INSERT INTO agent_versions (project_id, name, version, hash, spec, card, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
                """,
                project_id, spec.name, version, digest, spec.model_dump(mode="json"), card, actor,
            )  # fmt: skip
            await audit(conn, project_id, actor, "agent.register", f"{spec.name}@{version}", {"hash": digest})
        return dict(rec), True

    async def get_version(self, project_id: str, name: str, version: int) -> dict[str, Any] | None:
        rec = await self.pool.fetchrow(
            "SELECT * FROM agent_versions WHERE project_id = $1 AND name = $2 AND version = $3", project_id, name, version
        )
        return dict(rec) if rec else None

    async def latest_version(self, project_id: str, name: str) -> int | None:
        return await self.pool.fetchval(
            "SELECT max(version) FROM agent_versions WHERE project_id = $1 AND name = $2", project_id, name
        )

    async def list_versions(self, project_id: str, name: str) -> list[dict[str, Any]]:
        recs = await self.pool.fetch(
            "SELECT version, hash, card, created_by, created_at FROM agent_versions WHERE project_id = $1 AND name = $2 ORDER BY version DESC",
            project_id, name,
        )  # fmt: skip
        return [dict(r) for r in recs]

    async def set_alias(
        self, project_id: str, name: str, alias: str, target: AliasTarget | dict[str, Any], actor: str
    ) -> dict[str, Any]:
        target = target if isinstance(target, AliasTarget) else AliasTarget.model_validate(target)
        versions = [v.model_dump() for v in target.versions]
        async with self.pool.acquire() as conn, conn.transaction():
            known = {
                r["version"]
                for r in await conn.fetch(
                    "SELECT version FROM agent_versions WHERE project_id = $1 AND name = $2", project_id, name
                )
            }
            missing = [v["version"] for v in versions if v["version"] not in known]
            if missing:
                raise RegistryError([f"{name} has no version {v}" for v in missing])
            before = await conn.fetchval(
                "SELECT versions FROM aliases WHERE project_id = $1 AND name = $2 AND alias = $3", project_id, name, alias
            )
            rec = await conn.fetchrow(
                """
                INSERT INTO aliases (project_id, name, alias, versions, updated_by) VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (project_id, name, alias) DO UPDATE
                  SET versions = EXCLUDED.versions, updated_by = EXCLUDED.updated_by, updated_at = now()
                RETURNING *
                """,
                project_id, name, alias, versions, actor,
            )  # fmt: skip
            await audit(conn, project_id, actor, "alias.move", f"{name}@{alias}", {"from": before, "to": versions})
            await conn.execute("SELECT pg_notify($1, $2)", ALIAS_CHANNEL, f"{project_id}:{name}:{alias}")
        return dict(rec)

    async def get_alias(self, project_id: str, name: str, alias: str) -> list[dict[str, Any]] | None:
        return await self.pool.fetchval(
            "SELECT versions FROM aliases WHERE project_id = $1 AND name = $2 AND alias = $3", project_id, name, alias
        )

    async def list_aliases(self, project_id: str, name: str) -> list[dict[str, Any]]:
        recs = await self.pool.fetch(
            "SELECT alias, versions, updated_by, updated_at FROM aliases WHERE project_id = $1 AND name = $2 ORDER BY alias",
            project_id, name,
        )  # fmt: skip
        return [dict(r) for r in recs]

    async def search(
        self, project_id: str, *, query: str | None = None, tag: str | None = None, owner: str | None = None, capability: str | None = None
    ) -> list[dict[str, Any]]:
        recs = await self.pool.fetch(
            """
            SELECT a.name, a.description, a.tags, a.created_by, v.version AS latest_version, v.card, v.spec
            FROM agents a
            JOIN LATERAL (
                SELECT version, card, spec FROM agent_versions
                WHERE project_id = a.project_id AND name = a.name ORDER BY version DESC LIMIT 1
            ) v ON true
            WHERE a.project_id = $1
              AND ($2::text IS NULL OR a.name ILIKE '%' || $2 || '%' OR a.description ILIKE '%' || $2 || '%')
              AND ($3::text IS NULL OR $3 = ANY(a.tags))
              AND ($4::text IS NULL OR a.created_by = $4)
            ORDER BY a.name
            """,
            project_id, query, tag, owner,
        )  # fmt: skip
        out = []
        for r in recs:
            d = dict(r)
            spec = d.pop("spec")
            if capability and capability not in {t["name"] for t in spec.get("tools", [])} and capability not in {
                s["name"] for s in spec.get("skills", [])
            }:
                continue
            out.append(d)
        return out


async def audit(
    conn: asyncpg.Connection | asyncpg.Pool, project_id: str, actor: str, action: str, target: str, details: dict[str, Any] | None = None
) -> None:
    await conn.execute(
        "INSERT INTO audit_log (project_id, actor, action, target, details) VALUES ($1, $2, $3, $4, $5)",
        project_id, actor, action, target, details or {},
    )  # fmt: skip
