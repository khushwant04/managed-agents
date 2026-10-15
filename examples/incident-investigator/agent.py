"""The flagship demo agent: an incident investigator (ADR-0017).

Run locally (embedded runtime, local sandbox):

    runhive run examples/incident-investigator/agent.py "$(jq -r .alert examples/incident-investigator/scenarios/5xx_spike.json)"

Deploy (the tools become signed webhooks served by tools_server.py):

    TOOLS_URL=https://tools.example.com runhive apply examples/incident-investigator/agent.py --promote prod
    runhive deploy incident-investigator --http --webhook generic --cron "*/30 * * * *" --input "Check error budgets"
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).parent))

import observability  # noqa: E402

from runhive import Agent, tool  # noqa: E402

TOOLS_URL = os.environ.get("TOOLS_URL")  # hosted: where tools_server.py runs
MODELS = os.environ.get("INVESTIGATOR_MODELS", "claude-opus-5-5,gpt-6-astra").split(",")


def _url(name: str) -> str | None:
    return f"{TOOLS_URL.rstrip('/')}/tools/{name}" if TOOLS_URL else None


class DeployQuery(BaseModel):
    service: str | None = Field(default=None, description="Service name; omit for all services.")
    minutes: int = Field(default=120, description="How far back to look.")


class MetricsQuery(BaseModel):
    service: str
    minutes: int = 30


class LogQuery(BaseModel):
    query: str = Field(default="", description="Case-insensitive substring to match in the message.")
    service: str | None = None
    level: str | None = Field(default=None, description="ERROR, WARN or INFO.")
    limit: int = 50


@tool(url=_url("lookup_deploys"))
def lookup_deploys(q: DeployQuery) -> list[dict]:
    """List deploys in the last N minutes, newest last."""
    return observability.deploys(q.service, q.minutes)


@tool(url=_url("query_metrics"))
def query_metrics(q: MetricsQuery) -> list[dict]:
    """Error rate (%), p99 latency (ms) and requests per second for a service, every 3 minutes."""
    return observability.metrics(q.service, q.minutes)


@tool(url=_url("search_logs"))
def search_logs(q: LogQuery) -> list[dict]:
    """Search recent logs across services."""
    return observability.logs(q.query, q.service, q.level, q.limit)


INSTRUCTIONS = """\
You are an on-call incident investigator. Given an alert, find the root cause with evidence.

Work like a careful SRE:
1. Read the relevant runbook in /workspace/skills/runbooks before you start.
2. Establish when the problem started from metrics, then look at what changed around that time (deploys)
   and what failed (error logs), following traces across services.
3. Distinguish cause from coincidence: a change that happened after the errors started is not the cause.
4. Recommend the safest mitigation (usually a rollback of the change that caused it) and say who should act.

Write your findings to /workspace/outputs/report.md with these sections: Summary, Timeline, Root cause,
Evidence, Mitigation, Follow-ups. Then reply with a three-sentence summary."""

investigator = Agent(
    name="incident-investigator",
    model=MODELS,
    description="Investigates production alerts and writes an incident report.",
    instructions=INSTRUCTIONS,
    reasoning="high",
    tools=["shell", "files", lookup_deploys, query_metrics, search_logs],
    skills=[Path(__file__).parent / "skills" / "runbooks"],
    subagents={"max_concurrent": 3},
    model_options={"anthropic": {"cache": "1h"}},
    limits={"max_steps": 40, "max_wall_clock_s": 600},
    tags=["ops", "demo"],
)
