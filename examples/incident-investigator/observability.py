"""A fake observability backend for the demo: deploys, metrics and logs from a scenario file.

The same functions back the agent's tools in-process (``runhive run``) and the
signed webhook endpoints of ``tools_server.py`` (hosted deployments).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

SCENARIO = Path(os.environ.get("INCIDENT_SCENARIO", Path(__file__).parent / "scenarios" / "5xx_spike.json"))


def scenario() -> dict[str, Any]:
    return json.loads(SCENARIO.read_text())


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _window(minutes: int) -> tuple[datetime, datetime]:
    now = _ts(scenario()["now"])
    return now - timedelta(minutes=minutes), now


def deploys(service: str | None = None, minutes: int = 120) -> list[dict[str, Any]]:
    start, end = _window(minutes)
    return [
        d
        for d in scenario()["deploys"]
        if start <= _ts(d["at"]) <= end and (service is None or d["service"] == service)
    ]


def metrics(service: str, minutes: int = 30, step_minutes: int = 3) -> list[dict[str, Any]]:
    start, end = _window(minutes)
    rows = [m for m in scenario()["metrics"] if m["service"] == service and start <= _ts(m["ts"]) <= end]
    return rows[::step_minutes]


def logs(query: str = "", service: str | None = None, level: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    out = []
    for row in scenario()["logs"]:
        if service and row["service"] != service:
            continue
        if level and row["level"] != level.upper():
            continue
        if query and query.lower() not in row["message"].lower():
            continue
        out.append(row)
    return out[:limit]
