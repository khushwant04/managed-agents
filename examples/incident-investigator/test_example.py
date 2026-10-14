from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))


async def test_scripted_benchmark_scores_the_report():
    import benchmark

    result = await benchmark.run_once("scripted", 0, {}, benchmark.scripted_registry())
    assert result.stop_reason == "end_turn"
    assert result.found_deploy and result.found_service and result.score == 1.0
    assert result.tool_calls == 5


def test_tools_return_scenario_data():
    import observability

    assert [d["id"] for d in observability.deploys(minutes=120)] == ["deploy-4815", "deploy-4821", "deploy-4822"]
    assert observability.deploys("checkout-api")[0]["version"] == "v5.8.0"
    errors = observability.logs("nullpointer", level="error")
    assert errors and all(r["service"] == "checkout-api" for r in errors)
    series = observability.metrics("service-api", 30)
    assert max(m["error_rate_pct"] for m in series) > 5


def test_agent_definition_and_hosted_spec():
    from agent import investigator

    spec = investigator.spec()
    assert spec.models == ["claude-opus-5-5", "gpt-6-astra"]
    assert [t.name for t in spec.tools] == ["shell", "files", "lookup_deploys", "query_metrics", "search_logs"]
    assert spec.skills[0].name == "runbooks" and spec.skills[0].version


async def test_tools_server_checks_signatures(monkeypatch):
    import tools_server

    from agents.tools.webhook import sign

    monkeypatch.setattr(tools_server, "SECRET", "s3cret")
    body = json.dumps({"tool": "lookup_deploys", "arguments": {"service": "checkout-api"}}).encode()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=tools_server.app), base_url="http://t") as c:
        bad = await c.post("/tools/lookup_deploys", content=body, headers={"X-Agents-Signature": "t=1,v1=00"})
        assert bad.status_code == 401
        ok = await c.post(
            "/tools/lookup_deploys", content=body, headers={"X-Agents-Signature": sign("s3cret", body, int(time.time()))}
        )
        assert ok.json()["result"][0]["id"] == "deploy-4821"
