"""Server settings, read from environment variables."""

from __future__ import annotations

import os
import socket
import uuid
from dataclasses import dataclass, field


def _env(name: str, default: str | None = None) -> str | None:
    return os.environ.get(name, default)


@dataclass
class Settings:
    database_url: str = field(default_factory=lambda: _env("DATABASE_URL", "postgresql://agents:agents@localhost:5432/agents") or "")
    master_key: str | None = field(default_factory=lambda: _env("AGENTS_MASTER_KEY"))
    """Base64 32-byte key wrapping secret data keys (AES-GCM envelope encryption)."""
    blob_url: str = field(default_factory=lambda: _env("AGENTS_BLOB_URL", "file:///tmp/agents-blobs") or "")
    """``file:///path`` or ``s3://bucket/prefix`` (S3-compatible, e.g. MinIO, via AWS_* env vars)."""
    public_url: str = field(default_factory=lambda: _env("AGENTS_PUBLIC_URL", "http://localhost:8080") or "")
    sandbox_provider: str = field(default_factory=lambda: _env("AGENTS_SANDBOX_PROVIDER", "e2b") or "e2b")
    worker_id: str = field(default_factory=lambda: _env("AGENTS_WORKER_ID") or f"{socket.gethostname()}-{uuid.uuid4().hex[:6]}")
    worker_concurrency: int = field(default_factory=lambda: int(_env("AGENTS_WORKER_CONCURRENCY", "8") or 8))
    lease_seconds: int = field(default_factory=lambda: int(_env("AGENTS_LEASE_SECONDS", "30") or 30))
    idle_pause_seconds: int = field(default_factory=lambda: int(_env("AGENTS_IDLE_PAUSE_SECONDS", "300") or 300))
    poll_interval: float = field(default_factory=lambda: float(_env("AGENTS_POLL_INTERVAL", "1.0") or 1.0))
    bootstrap_key: str | None = field(default_factory=lambda: _env("AGENTS_BOOTSTRAP_KEY"))
    """Create a default org, project and this admin key at startup (development)."""
    max_call_depth: int = field(default_factory=lambda: int(_env("AGENTS_MAX_CALL_DEPTH", "3") or 3))
    rate_limit_per_minute: int = field(default_factory=lambda: int(_env("AGENTS_RATE_LIMIT_PER_MINUTE", "600") or 600))
