"""Prometheus metrics, exposed at ``/metrics``."""

from __future__ import annotations

from typing import Any

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

RUNS = Counter("agents_runs_total", "Runs finished, by stop reason.", ["agent", "stop_reason"])
TOKENS = Counter("agents_tokens_total", "Model tokens, by kind.", ["agent", "model", "kind"])
RUN_LATENCY = Histogram(
    "agents_run_seconds", "Wall time of a run.", ["agent"], buckets=(1, 2, 5, 10, 30, 60, 120, 300, 600, 1800)
)
TIME_TO_FIRST_TOKEN = Histogram(
    "agents_time_to_first_token_seconds", "Time from run start to the first streamed token.", ["agent"],
    buckets=(0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32),
)  # fmt: skip
TOOL_CALLS = Counter("agents_tool_calls_total", "Tool calls, by outcome.", ["tool", "outcome"])
PROVIDER_ERRORS = Counter("agents_provider_errors_total", "Model API errors, by kind.", ["model", "kind"])
QUEUE_DEPTH = Gauge("agents_queue_depth", "Runs waiting in the queue.")
SESSIONS_RESUMED = Counter("agents_sessions_resumed_total", "Runs resumed after a worker failure.")
CACHE_HIT_RATIO = Gauge("agents_cache_hit_ratio", "Cached input tokens over all input tokens in the last run.", ["agent"])
HTTP_REQUESTS = Counter("agents_http_requests_total", "Gateway requests.", ["method", "route", "status"])


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
