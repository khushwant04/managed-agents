"""Secrets: AES-GCM envelope encryption (ADR-0010).

Each secret value is encrypted with its own random data key; the data key is
wrapped with the master key (from ``RUNHIVE_MASTER_KEY``, or a KMS through the
``KeyWrapper`` protocol). Secrets are referenced by name and only decrypted by
the tool gateway at call time; they never enter model context or sandboxes.
"""

from __future__ import annotations

import base64
import hashlib
import os
from typing import Protocol

import asyncpg
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .registry import audit


class KeyWrapper(Protocol):
    key_id: str

    def wrap(self, data_key: bytes) -> bytes: ...

    def unwrap(self, wrapped: bytes) -> bytes: ...


class LocalKeyWrapper:
    """Wraps data keys with a 32-byte master key held in process memory."""

    def __init__(self, master_key: bytes) -> None:
        if len(master_key) != 32:
            raise ValueError("the master key must be 32 bytes (base64-encoded in RUNHIVE_MASTER_KEY)")
        self._aead = AESGCM(master_key)
        self.key_id = "local:" + hashlib.sha256(master_key).hexdigest()[:12]

    @classmethod
    def from_env(cls, value: str | None) -> LocalKeyWrapper:
        if not value:
            raise ValueError("RUNHIVE_MASTER_KEY is not set; generate one with: python -c \"import os,base64;print(base64.b64encode(os.urandom(32)).decode())\"")
        return cls(base64.b64decode(value))

    def wrap(self, data_key: bytes) -> bytes:
        nonce = os.urandom(12)
        return nonce + self._aead.encrypt(nonce, data_key, b"agents-data-key")

    def unwrap(self, wrapped: bytes) -> bytes:
        return self._aead.decrypt(wrapped[:12], wrapped[12:], b"agents-data-key")


class SecretNotFound(KeyError):
    pass


class SecretStore:
    def __init__(self, pool: asyncpg.Pool, wrapper: KeyWrapper) -> None:
        self.pool = pool
        self.wrapper = wrapper

    @staticmethod
    def _aad(project_id: str, name: str) -> bytes:
        return f"{project_id}/{name}".encode()

    async def put(self, project_id: str, name: str, value: str, actor: str) -> int:
        data_key = AESGCM.generate_key(bit_length=256)
        nonce = os.urandom(12)
        ciphertext = AESGCM(data_key).encrypt(nonce, value.encode(), self._aad(project_id, name))
        async with self.pool.acquire() as conn, conn.transaction():
            version = await conn.fetchval(
                """
                INSERT INTO secrets (project_id, name, ciphertext, nonce, wrapped_key, key_id) VALUES ($1,$2,$3,$4,$5,$6)
                ON CONFLICT (project_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce,
                    wrapped_key = EXCLUDED.wrapped_key, key_id = EXCLUDED.key_id, version = secrets.version + 1, rotated_at = now()
                RETURNING version
                """,
                project_id, name, ciphertext, nonce, self.wrapper.wrap(data_key), self.wrapper.key_id,
            )  # fmt: skip
            await audit(conn, project_id, actor, "secret.write", name, {"version": version})
        return int(version)

    async def get(self, project_id: str, name: str, *, actor: str = "system", reason: str = "") -> str:
        rec = await self.pool.fetchrow(
            "SELECT ciphertext, nonce, wrapped_key FROM secrets WHERE project_id = $1 AND name = $2", project_id, name
        )
        if rec is None:
            raise SecretNotFound(name)
        data_key = self.wrapper.unwrap(rec["wrapped_key"])
        value = AESGCM(data_key).decrypt(rec["nonce"], rec["ciphertext"], self._aad(project_id, name)).decode()
        await audit(self.pool, project_id, actor, "secret.read", name, {"reason": reason} if reason else {})
        return value

    async def list(self, project_id: str) -> list[dict[str, object]]:
        recs = await self.pool.fetch(
            "SELECT name, version, key_id, created_at, rotated_at FROM secrets WHERE project_id = $1 ORDER BY name", project_id
        )
        return [dict(r) for r in recs]

    async def delete(self, project_id: str, name: str, actor: str) -> bool:
        res = await self.pool.execute("DELETE FROM secrets WHERE project_id = $1 AND name = $2", project_id, name)
        await audit(self.pool, project_id, actor, "secret.delete", name)
        return res.endswith("1")
