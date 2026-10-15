from __future__ import annotations

import pytest

from runhive import Agent, tool
from runhive.runtime.local import LocalRuntime
from runhive.testing import ScriptedAdapter, call, scripted_registry, text

sdk = pytest.importorskip("opentelemetry.sdk.trace")
from opentelemetry import trace  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter  # noqa: E402


@pytest.fixture(scope="module")
def exporter():
    exp = InMemorySpanExporter()
    provider = sdk.TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exp))
    trace.set_tracer_provider(provider)
    import runhive.tracing as t

    t._tracer = trace.get_tracer("runhive")
    return exp


async def test_spans_for_run_model_and_tool(exporter):
    exporter.clear()

    @tool
    def ping() -> str:
        """Ping."""
        return "pong"

    adapter = ScriptedAdapter([call("ping", {}, id="p1"), text("done")])
    runtime = LocalRuntime(adapters=scripted_registry(adapter))
    sid = await runtime.create_session(Agent("traced", "scripted", tools=[ping]).spec(), functions={"ping": ping})
    await runtime.send(sid, "go")
    await runtime.wait(sid)
    spans = {s.name: s for s in exporter.get_finished_spans()}
    assert {"invoke_agent traced", "chat scripted", "execute_tool ping"} <= set(spans)
    run = spans["invoke_agent traced"]
    assert run.attributes["gen_ai.agent.name"] == "traced" and run.attributes["runhive.stop_reason"] == "end_turn"
    chat = spans["chat scripted"]
    assert chat.attributes["gen_ai.operation.name"] == "chat" and chat.attributes["gen_ai.usage.output_tokens"] == 5
    assert chat.parent.span_id == run.context.span_id
    tool_span = spans["execute_tool ping"]
    assert tool_span.attributes["gen_ai.tool.call.id"] == "p1" and tool_span.attributes["runhive.tool.is_error"] is False
