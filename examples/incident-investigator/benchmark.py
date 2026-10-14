"""Benchmark: the same incident on several models (time, tokens, cost, correctness).

    uv run python examples/incident-investigator/benchmark.py --models claude-opus-5-5 gpt-6-astra --runs 3
    uv run python examples/incident-investigator/benchmark.py --scripted     # no API keys: checks the harness

Each run uses a fresh local sandbox and the embedded runtime, so results
compare models, not infrastructure. Correctness is graded mechanically from
/workspace/outputs/report.md against the scenario's expected root cause.
Prices (USD per million tokens) come from prices.json; fill in any model
you benchmark that is missing there.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import observability  # noqa: E402
from agent import investigator  # noqa: E402

from agents import Agent, Sandbox  # noqa: E402
from agents.adapters import AdapterRegistry  # noqa: E402


@dataclass
class Result:
    model: str
    run: int
    seconds: float
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    tool_calls: int
    cost_usd: float | None
    score: float
    found_deploy: bool
    found_service: bool
    stop_reason: str
    error: str | None = None


def grade(report: str, expected: dict) -> tuple[float, bool, bool]:
    text = report.lower()
    found_deploy = expected["deploy"].lower() in text
    found_service = expected["service"].lower() in text
    keywords = [k.lower() in text for k in expected["keywords"]]
    checks = [found_deploy, found_service, *keywords]
    return sum(checks) / len(checks), found_deploy, found_service


def cost(model: str, r: dict, prices: dict) -> float | None:
    p = prices.get(model)
    if not p:
        return None
    return (
        r["input_tokens"] * p["input"]
        + r["output_tokens"] * p["output"]
        + r["cache_read_tokens"] * p.get("cache_read", p["input"])
        + r["cache_write_tokens"] * p.get("cache_write", p["input"])
    ) / 1_000_000


async def run_once(model: str, n: int, prices: dict, adapters: AdapterRegistry | None) -> Result:
    spec = investigator.spec().model_copy(update={"models": [model]})
    agent = Agent.from_spec(spec, functions=list(investigator.functions.values()))
    agent.skills = investigator.skills
    scenario = observability.scenario()
    started = time.monotonic()
    session = await agent.astart(scenario["alert"], sandbox=Sandbox.local(), adapters=adapters)
    try:
        tool_calls = 0
        async for ev in session.events():
            tool_calls += ev.type == "tool.call"
        result = session.result
        files = {f.path: f.text for f in await session.artifacts()}
    finally:
        await session.close()
    seconds = time.monotonic() - started
    usage = result.usage.model_dump() if result else {}
    report = files.get("/workspace/outputs/report.md", "")
    score, deploy, service = grade(report, scenario["expected"])
    return Result(
        model=model,
        run=n,
        seconds=round(seconds, 2),
        tool_calls=tool_calls,
        cost_usd=cost(model, usage, prices),
        score=round(score, 2),
        found_deploy=deploy,
        found_service=service,
        stop_reason=result.stop_reason if result else "error",
        error=result.error if result else "no result",
        **{k: usage.get(k, 0) for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")},
    )


def table(results: list[Result]) -> str:
    lines = [
        "| Model | Runs | Correct root cause | Score | Median time (s) | Median tokens in / out | Median cost (USD) | Tool calls |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for model in dict.fromkeys(r.model for r in results):
        rs = [r for r in results if r.model == model]
        med = lambda xs: statistics.median(xs) if xs else 0  # noqa: E731
        costs = [r.cost_usd for r in rs if r.cost_usd is not None]
        tokens_in = med([r.input_tokens + r.cache_read_tokens + r.cache_write_tokens for r in rs])
        lines.append(
            f"| {model} | {len(rs)} | {sum(r.found_deploy for r in rs)}/{len(rs)} | {med([r.score for r in rs]):.2f} "
            f"| {med([r.seconds for r in rs]):.1f} | {tokens_in:,.0f} / {med([r.output_tokens for r in rs]):,.0f} "
            f"| {f'{med(costs):.4f}' if costs else 'n/a'} | {med([r.tool_calls for r in rs]):.0f} |"
        )
    return "\n".join(lines)


def scripted_registry() -> AdapterRegistry:
    """A canned investigation, to exercise the harness without API keys."""
    from agents.testing import ScriptedAdapter, call, calls, text

    report = (
        "# Incident report\\n\\n## Summary\\nservice-api 5xx came from checkout-api after deploy-4821.\\n\\n"
        "## Root cause\\nNullPointerException in DiscountResolver.resolve (checkout-api v5.8.0, deploy-4821).\\n\\n"
        "## Mitigation\\nRollback deploy-4821; owners #team-checkout.\\n"
    )
    adapter = ScriptedAdapter(
        [
            call("files", {"command": "view", "path": "/workspace/skills/runbooks/SKILL.md"}),
            calls([("query_metrics", {"service": "service-api", "minutes": 30}), ("lookup_deploys", {"minutes": 120})]),
            call("search_logs", {"level": "ERROR"}),
            call("shell", {"command": f"printf '{report}' > /workspace/outputs/report.md"}),
            text("checkout-api deploy-4821 introduced a NullPointerException in DiscountResolver; roll it back."),
        ]
    )
    reg = AdapterRegistry()
    reg.register("scripted", adapter)
    return reg


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", nargs="+", default=["claude-opus-5-5", "gpt-6-astra"])
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--prices", default=str(HERE / "prices.json"))
    parser.add_argument("--out", default=str(HERE / "results"))
    parser.add_argument("--scripted", action="store_true", help="dry run with a scripted model")
    args = parser.parse_args()
    prices = json.loads(Path(args.prices).read_text())
    models = ["scripted"] if args.scripted else args.models
    results: list[Result] = []
    for model in models:
        for n in range(1 if args.scripted else args.runs):
            adapters = scripted_registry() if args.scripted else None
            r = await run_once(model, n, prices, adapters)
            print(f"{model} #{n}: score {r.score} in {r.seconds}s ({r.stop_reason})", file=sys.stderr)
            results.append(r)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    (out / f"{stamp}.json").write_text(json.dumps([asdict(r) for r in results], indent=2))
    print(table(results))


if __name__ == "__main__":
    asyncio.run(main())
