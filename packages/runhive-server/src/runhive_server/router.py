"""The router: ``name@alias`` → exact version (ADR-0007).

The alias table is cached in memory and invalidated by Postgres NOTIFY when
an alias moves. Weighted aliases split *new* sessions, sticky by a hash of
the session ID; an existing session keeps its version.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from .registry import Registry


class RouteError(LookupError):
    pass


@dataclass(frozen=True)
class Route:
    agent: str
    alias: str | None
    version: int


def parse_target(target: str) -> tuple[str, str | None]:
    """``name@alias``, ``name@14`` (exact version), ``name@latest`` or bare ``name`` (= ``@prod``)."""
    name, _, ref = target.partition("@")
    if not name:
        raise RouteError(f"invalid agent reference {target!r}")
    return name, ref or "prod"


def bucket(session_id: str) -> int:
    """A stable bucket in [0, 100) for sticky traffic splits."""
    return int.from_bytes(hashlib.sha256(session_id.encode()).digest()[:8], "big") % 100


def pick_version(versions: list[dict[str, Any]], session_id: str) -> int:
    b = bucket(session_id)
    edge = 0
    for v in versions:
        edge += v["weight"]
        if b < edge:
            return int(v["version"])
    return int(versions[-1]["version"])


class AliasCache:
    def __init__(self, registry: Registry) -> None:
        self.registry = registry
        self._cache: dict[tuple[str, str, str], list[dict[str, Any]] | None] = {}
        self.hits = 0
        self.misses = 0

    async def get(self, project_id: str, name: str, alias: str) -> list[dict[str, Any]] | None:
        key = (project_id, name, alias)
        if key in self._cache:
            self.hits += 1
            return self._cache[key]
        self.misses += 1
        versions = await self.registry.get_alias(project_id, name, alias)
        self._cache[key] = versions
        return versions

    def invalidate(self, payload: str | None = None) -> None:
        """Called from NOTIFY ``runhive_aliases`` with ``project:name:alias``; None clears all."""
        if not payload:
            self._cache.clear()
            return
        parts = payload.split(":", 2)
        if len(parts) == 3:
            self._cache.pop((parts[0], parts[1], parts[2]), None)
        else:
            self._cache.clear()


class Router:
    def __init__(self, registry: Registry, cache: AliasCache | None = None) -> None:
        self.registry = registry
        self.cache = cache or AliasCache(registry)

    async def resolve(self, project_id: str, target: str, session_id: str) -> Route:
        name, ref = parse_target(target)
        assert ref is not None
        if ref.isdigit():
            version = int(ref)
            if await self.registry.get_version(project_id, name, version) is None:
                raise RouteError(f"{name} has no version {version}")
            return Route(name, None, version)
        if ref == "latest":
            latest = await self.registry.latest_version(project_id, name)
            if latest is None:
                raise RouteError(f"unknown agent {name!r}")
            return Route(name, "latest", latest)
        versions = await self.cache.get(project_id, name, ref)
        if not versions:
            raise RouteError(f"{name} has no alias {ref!r}")
        return Route(name, ref, pick_version(versions, session_id))
