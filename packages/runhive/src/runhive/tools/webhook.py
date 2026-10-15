"""Function tools hosted at a URL, called as HMAC-signed webhooks (ADR-0009).

The gateway POSTs ``{"tool", "arguments", "call_id", "session_id", "run_id"}``
with these headers:

- ``X-Runhive-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>." + body)>``
- ``Idempotency-Key``: the same on every retry and when a run resumes after a
  crash; receivers should deduplicate on it.
- injected secrets, e.g. ``Authorization: Bearer <secret>`` (ADR-0010).

Receivers check the signature with ``verify`` and reply with
``{"result": ...}``, ``{"error": "..."}`` or plain text.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from typing import Any
from urllib.parse import urlsplit

import httpx

from .executor import ToolExecutionError

SIGNATURE_HEADER = "X-Runhive-Signature"
IDEMPOTENCY_HEADER = "Idempotency-Key"
MAX_RETRY_AFTER_S = 30.0


def _key(secret: bytes | str) -> bytes:
    return secret.encode() if isinstance(secret, str) else secret


def _digest(secret: bytes | str, body: bytes, timestamp: int) -> str:
    return hmac.new(_key(secret), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()


def sign(secret: bytes | str, body: bytes, timestamp: int) -> str:
    """The ``X-Runhive-Signature`` header value for ``body`` sent at ``timestamp``."""
    return f"t={timestamp},v1={_digest(secret, body, timestamp)}"


def verify(
    secret: bytes | str, header: str, body: bytes, *, tolerance_s: int = 300, now: float | None = None
) -> bool:
    """Check a signature header on a received webhook; for receivers.

    Rejects timestamps more than ``tolerance_s`` away from ``now``. Several
    ``v1`` values are accepted, so a sender can sign with two secrets while
    rotating.
    """
    timestamp: int | None = None
    candidates: list[str] = []
    for part in (header or "").split(","):
        key, _, value = part.strip().partition("=")
        if key == "t":
            try:
                timestamp = int(value)
            except ValueError:
                return False
        elif key == "v1":
            candidates.append(value)
    if timestamp is None or not candidates:
        return False
    current = time.time() if now is None else now
    if abs(current - timestamp) > tolerance_s:
        return False
    expected = _digest(secret, body, timestamp)
    return any(hmac.compare_digest(expected, c) for c in candidates)


class EgressPolicy:
    """Which hosts tool calls may reach. ``None`` allows every host.

    Entries are exact hosts (``api.example.com``) or wildcards
    (``*.example.com``, which matches subdomains but not ``example.com``).
    """

    def __init__(self, allowed_hosts: list[str] | None = None) -> None:
        self.allowed_hosts = [h.lower().rstrip(".") for h in allowed_hosts] if allowed_hosts is not None else None

    def allows(self, url: str) -> bool:
        parts = urlsplit(url)
        host = (parts.hostname or "").rstrip(".")
        if parts.scheme not in ("http", "https") or not host:
            return False
        if self.allowed_hosts is None:
            return True
        for pattern in self.allowed_hosts:
            if pattern.startswith("*."):
                if host.endswith(pattern[1:]):
                    return True
            elif host == pattern:
                return True
        return False

    def check(self, url: str) -> None:
        if not self.allows(url):
            raise ToolExecutionError(f"Egress to {urlsplit(url).hostname or url!r} is not allowed by policy.")


class WebhookCaller:
    """Calls function tools at their URL, signed and retried."""

    def __init__(
        self,
        signing_secret: bytes | str,
        *,
        client: httpx.AsyncClient | None = None,
        max_attempts: int = 3,
        backoff_s: float = 0.5,
        timeout_s: float = 30,
        egress: EgressPolicy | None = None,
    ) -> None:
        self.signing_secret = signing_secret
        self.client = client
        self.max_attempts = max(1, max_attempts)
        self.backoff_s = backoff_s
        self.timeout_s = timeout_s
        self.egress = egress

    async def call(
        self,
        url: str,
        *,
        tool: str,
        arguments: dict[str, Any],
        idempotency_key: str,
        session_id: str,
        run_id: str,
        call_id: str,
        headers: dict[str, str] | None = None,
    ) -> str:
        (self.egress or EgressPolicy()).check(url)
        body = json.dumps(
            {"tool": tool, "arguments": arguments, "call_id": call_id, "session_id": session_id, "run_id": run_id},
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
        if self.client is not None:
            return await self._call(self.client, url, tool, body, idempotency_key, headers or {})
        async with httpx.AsyncClient() as client:
            return await self._call(client, url, tool, body, idempotency_key, headers or {})

    async def _call(
        self, client: httpx.AsyncClient, url: str, tool: str, body: bytes, key: str, extra: dict[str, str]
    ) -> str:
        last = ""
        for attempt in range(1, self.max_attempts + 1):
            delay = self.backoff_s * 2 ** (attempt - 1)
            headers = {
                **extra,
                "Content-Type": "application/json",
                IDEMPOTENCY_HEADER: key,
                SIGNATURE_HEADER: sign(self.signing_secret, body, int(time.time())),
            }
            try:
                resp = await client.post(url, content=body, headers=headers, timeout=self.timeout_s)
            except httpx.TransportError as exc:
                last = f"{type(exc).__name__}: {exc}"
            else:
                if resp.status_code == 429 or resp.status_code >= 500:
                    last = f"HTTP {resp.status_code}: {_excerpt(resp.text)}"
                    delay = max(delay, _retry_after(resp))
                elif resp.status_code >= 300:
                    raise ToolExecutionError(f"Tool {tool} webhook returned HTTP {resp.status_code}: {_excerpt(resp.text)}")
                else:
                    return _result(tool, resp)
            if attempt < self.max_attempts:
                await asyncio.sleep(delay)
        raise ToolExecutionError(f"Tool {tool} webhook failed after {self.max_attempts} attempts ({last}).")


def _result(tool: str, resp: httpx.Response) -> str:
    text = resp.text
    if "json" in resp.headers.get("content-type", ""):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return text
        if isinstance(data, dict):
            if "result" in data:
                result = data["result"]
                return result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
            if "error" in data:
                error = data["error"]
                if isinstance(error, dict) and isinstance(error.get("message"), str):
                    error = error["message"]
                raise ToolExecutionError(error if isinstance(error, str) else json.dumps(error, ensure_ascii=False))
    return text


def _retry_after(resp: httpx.Response) -> float:
    try:
        return min(float(resp.headers.get("retry-after", "0")), MAX_RETRY_AFTER_S)
    except ValueError:
        return 0.0


def _excerpt(text: str, limit: int = 200) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit] + "..."
