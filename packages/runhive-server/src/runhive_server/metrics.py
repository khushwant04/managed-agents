"""Prometheus metrics, exposed at ``/metrics``."""

from __future__ import annotations

from typing import Any

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

RUNS = Counter("runhive_runs_total", "Runs finished, by stop reason.", ["agent", "stop_reason"])
TOKENS = Counter("runhive_tokens_total", "Model tokens, by kind.", ["agent", "model", "kind"])
RUN_LATENCY = Histogram(
    "runhive_run_seconds", "Wall time of a run.", ["agent"], buckets=(1, 2, 5, 10, 30, 60, 120, 300, 600, 1800)
)
TIME_TO_FIRST_TOKEN = Histogram(
    "runhive_time_to_first_token_seconds", "Time from run start to the first streamed token.", ["agent"],
    buckets=(0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32),
)  # fmt: skip
TOOL_CALLS = Counter("runhive_tool_calls_total", "Tool calls, by outcome.", ["tool", "outcome"])
PROVIDER_ERRORS = Counter("runhive_provider_errors_total", "Model API errors, by kind.", ["model", "kind"])
QUEUE_DEPTH = Gauge("runhive_queue_depth", "Runs waiting in the queue.")
SESSIONS_RESUMED = Counter("runhive_sessions_resumed_total", "Runs resumed after a worker failure.")
CACHE_HIT_RATIO = Gauge("runhive_cache_hit_ratio", "Cached input tokens over all input tokens in the last run.", ["agent"])
HTTP_REQUESTS = Counter("runhive_http_requests_total", "Gateway requests.", ["method", "route", "status"])


def record_run(result: Any, agent: str) -> None:
    RUNS.labels(agent, result.stop_reason).inc()
    u = result.usage
    model = result.model or "unknown"
    for kind, value in (
        ("input", u.input_tokens),
        ("output", u.output_tokens),
        ("cache_read", u.cache_read_tokens),
        ("cache_write", u.cache_write_tokens),
    ):
        if value:
            TOKENS.labels(agent, model, kind).inc(value)
    total_in = u.input_tokens + u.cache_read_tokens + u.cache_write_tokens
    if total_in:
        CACHE_HIT_RATIO.labels(agent).set(u.cache_read_tokens / total_in)


def render() -> tuple[bytes, str]:
    return generate_latest(), CONTENT_TYPE_LATEST


class MetricsEventLog:
    """Wraps an event log to record time to first token, provider errors and tool outcomes."""

    def __init__(self, inner: Any, agent: str, started: float) -> None:
        self.inner = inner
        self.agent = agent
        self.started = started
        self._first_token = False

    async def append(self, event: Any) -> Any:
        import time

        if event.type == "message.agent.delta" and not self._first_token:
            self._first_token = True
            TIME_TO_FIRST_TOKEN.labels(self.agent).observe(time.monotonic() - self.started)
        elif event.type == "tool.result":
            TOOL_CALLS.labels(event.payload.get("name", "unknown"), "error" if event.payload.get("is_error") else "ok").inc()
        elif event.type == "error":
            p = event.payload
            if p.get("kind") == "model_fallback":
                PROVIDER_ERRORS.labels(p.get("from", "unknown"), p.get("reason", "unknown")).inc()
            elif p.get("kind") in ("rate_limit", "server", "connection", "refusal", "bad_request", "auth"):
                PROVIDER_ERRORS.labels(event.model or "unknown", p["kind"]).inc()
        return await self.inner.append(event)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)
