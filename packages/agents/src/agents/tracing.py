"""OpenTelemetry spans for runs, model calls and tool calls.

Spans follow the GenAI semantic conventions (``invoke_agent``, ``chat``,
``execute_tool`` with ``gen_ai.*`` attributes) and carry the agent version and
resolved route. Without ``opentelemetry-api`` installed every call is a no-op.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Any

try:  # pragma: no cover - exercised when the dependency is present
    from opentelemetry import trace as _trace
    from opentelemetry.trace import Status, StatusCode

    _tracer: Any = _trace.get_tracer("managed-agents")
except ImportError:  # pragma: no cover
    _tracer = None


class _NoSpan:
    def set_attribute(self, key: str, value: Any) -> None:
        pass

    def set_attributes(self, attrs: dict[str, Any]) -> None:
        pass

    def record_exception(self, exc: BaseException) -> None:
        pass

    def set_status(self, *args: Any, **kwargs: Any) -> None:
        pass


def _clean(attrs: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in attrs.items() if v is not None}


@contextlib.contextmanager
def span(name: str, attributes: dict[str, Any] | None = None) -> Iterator[Any]:
    if _tracer is None:
        yield _NoSpan()
        return
    with _tracer.start_as_current_span(name, attributes=_clean(attributes or {}), record_exception=False) as s:
        try:
            yield s
        except BaseException as exc:
            s.record_exception(exc)
            s.set_status(Status(StatusCode.ERROR, str(exc)))
            raise


def run_attributes(*, agent: str, session_id: str, run_id: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": agent,
        "gen_ai.conversation.id": session_id,
        "agents.session_id": session_id,
        "agents.run_id": run_id,
        **(extra or {}),
    }


def model_attributes(*, vendor: str, model: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": vendor,
        "gen_ai.system": vendor,
        "gen_ai.request.model": model,
        **(extra or {}),
    }


def usage_attributes(response: Any) -> dict[str, Any]:
    u = response.usage
    return {
        "gen_ai.response.model": response.model,
        "gen_ai.response.finish_reasons": [response.stop_reason],
        "gen_ai.usage.input_tokens": u.input_tokens + u.cache_read_tokens + u.cache_write_tokens,
        "gen_ai.usage.output_tokens": u.output_tokens,
        "agents.usage.cache_read_tokens": u.cache_read_tokens,
        "agents.usage.cache_write_tokens": u.cache_write_tokens,
    }


def tool_attributes(*, name: str, call_id: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": name,
        "gen_ai.tool.call.id": call_id,
        **(extra or {}),
    }
