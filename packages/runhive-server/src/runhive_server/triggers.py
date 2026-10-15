"""Deployment triggers: HTTP invoke, signed inbound webhooks, cron and queue.

Trigger shapes::

    {"type": "http"}
    {"type": "webhook", "provider": "github" | "slack" | "stripe" | "generic", "input": "<template>"}
    {"type": "cron", "schedule": "*/30 * * * *", "input": "Check error budgets", "timezone": "UTC"}
    {"type": "queue", "name": "alerts"}

Webhook input templates use ``{body}`` (the raw body), ``{event}`` (the
provider's event name) and dotted paths into a JSON body such as
``{issue.title}``. Without a template the input is the event name and body.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from croniter import croniter

TRIGGER_TYPES = {"http", "webhook", "cron", "queue"}
PROVIDERS = {"github", "slack", "stripe", "generic"}


class TriggerError(ValueError):
    pass


def validate_triggers(triggers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for t in triggers:
        kind = t.get("type")
        if kind not in TRIGGER_TYPES:
            raise TriggerError(f"unknown trigger type {kind!r}; expected one of {sorted(TRIGGER_TYPES)}")
        if kind == "cron":
            if not croniter.is_valid(t.get("schedule", "")):
                raise TriggerError(f"invalid cron schedule {t.get('schedule')!r}")
            if not t.get("input"):
                raise TriggerError("a cron trigger needs an input")
            ZoneInfo(t.get("timezone", "UTC"))
        if kind == "webhook" and t.get("provider", "generic") not in PROVIDERS:
            raise TriggerError(f"unknown webhook provider {t.get('provider')!r}")
        if kind == "queue" and not t.get("name"):
            raise TriggerError("a queue trigger needs a name")
        out.append(dict(t))
    return out


def next_cron(schedule: str, after: datetime, timezone: str = "UTC") -> datetime:
    tz = ZoneInfo(timezone)
    return croniter(schedule, after.astimezone(tz)).get_next(datetime).astimezone(UTC)


# -- webhook signatures ------------------------------------------------------


def _hmac(secret: str, payload: bytes) -> str:
    return hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


def verify_webhook(
    provider: str, secret: str, headers: dict[str, str], body: bytes, *, tolerance_s: int = 300, now: float | None = None
) -> bool:
    """Check an inbound webhook's signature the way its provider signs it."""
    h = {k.lower(): v for k, v in headers.items()}
    now = now or time.time()
    if provider == "github":
        sig = h.get("x-hub-signature-256", "")
        return sig.startswith("sha256=") and hmac.compare_digest(sig[7:], _hmac(secret, body))
    if provider == "slack":
        ts, sig = h.get("x-slack-request-timestamp", ""), h.get("x-slack-signature", "")
        if not ts.isdigit() or abs(now - int(ts)) > tolerance_s:
            return False
        expected = "v0=" + _hmac(secret, f"v0:{ts}:".encode() + body)
        return hmac.compare_digest(sig, expected)
    if provider in ("stripe", "generic"):
        header = h.get("stripe-signature" if provider == "stripe" else "x-runhive-signature", "")
        parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
        ts = parts.get("t", "")
        if not ts.isdigit() or abs(now - int(ts)) > tolerance_s:
            return False
        expected = _hmac(secret, f"{ts}.".encode() + body)
        candidates = [v for k, v in (p.split("=", 1) for p in header.split(",") if "=" in p) if k == "v1"]
        return any(hmac.compare_digest(c, expected) for c in candidates)
    return False


def event_name(provider: str, headers: dict[str, str], payload: Any) -> str:
    h = {k.lower(): v for k, v in headers.items()}
    if provider == "github":
        action = payload.get("action") if isinstance(payload, dict) else None
        return h.get("x-github-event", "event") + (f".{action}" if action else "")
    if provider == "stripe" and isinstance(payload, dict):
        return str(payload.get("type", "event"))
    if provider == "slack" and isinstance(payload, dict):
        return str((payload.get("event") or {}).get("type") or payload.get("type", "event"))
    return h.get("x-runhive-event", "event")


_FIELD = re.compile(r"\{([a-zA-Z0-9_.]+)\}")


def render_input(template: str | None, provider: str, headers: dict[str, str], body: bytes) -> str:
    try:
        payload: Any = json.loads(body) if body else {}
    except json.JSONDecodeError:
        payload = None
    event = event_name(provider, headers, payload)
    text_body = body.decode("utf-8", errors="replace")
    if not template:
        return f"Webhook event: {event}\n\n{text_body}"

    def lookup(m: re.Match[str]) -> str:
        path = m.group(1)
        if path == "body":
            return text_body
        if path == "event":
            return event
        value: Any = payload
        for part in path.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        return "" if value is None else value if isinstance(value, str) else json.dumps(value)

    return _FIELD.sub(lookup, template)


def slack_url_verification(body: bytes) -> str | None:
    """Slack's endpoint check: echo the challenge."""
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return None
    if isinstance(payload, dict) and payload.get("type") == "url_verification":
        return str(payload.get("challenge", ""))
    return None
