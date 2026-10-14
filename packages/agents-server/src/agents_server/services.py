"""Wires the platform together; shared by the API, workers, scheduler and tests."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any

import asyncpg

from agents.adapters import AdapterRegistry

from .auth import bootstrap
from .blobs import BlobStore, blob_store
from .config import Settings
from .db import create_pool, migrate
from .queue import RunQueue
from .registry import ALIAS_CHANNEL, Registry
from .router import AliasCache, Router
from .secrets import LocalKeyWrapper, SecretStore
from .service import Platform
from .stores import PostgresEventLog, PostgresStepStore, StreamHub


@dataclass
class Services:
    settings: Settings
    pool: asyncpg.Pool
    platform: Platform
    hub: StreamHub | None
    adapters: AdapterRegistry
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    async def start(
        cls,
        settings: Settings | None = None,
        *,
        pool: asyncpg.Pool | None = None,
        adapters: AdapterRegistry | None = None,
        blobs: BlobStore | None = None,
        listen: bool = True,
        run_migrations: bool = True,
    ) -> Services:
        settings = settings or Settings()
        pool = pool or await create_pool(settings.database_url, max_size=20)
        if run_migrations:
            await migrate(pool)
        adapters = adapters or AdapterRegistry()
        registry = Registry(pool, adapters)
        cache = AliasCache(registry)
        hub: StreamHub | None = None
        if listen:
            hub = StreamHub(settings.database_url)
            await hub.start()
            await hub.listen(ALIAS_CHANNEL, cache.invalidate)
        secrets = None
        if settings.master_key:
            secrets = SecretStore(pool, LocalKeyWrapper(base64.b64decode(settings.master_key)))
        platform = Platform(
            pool,
            registry=registry,
            router=Router(registry, cache),
            queue=RunQueue(pool, lease_seconds=settings.lease_seconds),
            events=PostgresEventLog(pool, hub),
            steps=PostgresStepStore(pool),
            secrets=secrets,
            blobs=blobs or blob_store(settings.blob_url),
            max_call_depth=settings.max_call_depth,
        )
        if settings.bootstrap_key:
            await bootstrap(pool, settings.bootstrap_key)
        return cls(settings=settings, pool=pool, platform=platform, hub=hub, adapters=adapters)

    def worker(self, **kwargs: Any) -> Any:
        from .worker import Worker

        return Worker(
            self.platform,
            worker_id=kwargs.pop("worker_id", self.settings.worker_id),
            adapters=self.adapters,
            default_provider=self.settings.sandbox_provider,
            concurrency=kwargs.pop("concurrency", self.settings.worker_concurrency),
            lease_seconds=self.settings.lease_seconds,
            **kwargs,
        )

    async def stop(self) -> None:
        if self.hub is not None:
            await self.hub.stop()
        await self.pool.close()
