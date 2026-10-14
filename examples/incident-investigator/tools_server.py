"""The demo's tools as signed webhooks, for hosted deployments.

    TOOL_SIGNING_SECRET=<deployment webhook secret> uvicorn tools_server:app --port 9000

The platform's tool gateway POSTs ``{"tool", "arguments", "call_id", ...}``
signed with ``X-Agents-Signature``; requests with a bad signature are rejected.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request

sys.path.insert(0, str(Path(__file__).parent))

import observability  # noqa: E402

from agents.tools.webhook import verify  # noqa: E402

app = FastAPI(title="incident-investigator tools")
SECRET = os.environ.get("TOOL_SIGNING_SECRET", "")
HANDLERS = {
    "lookup_deploys": lambda a: observability.deploys(a.get("service"), a.get("minutes", 120)),
    "query_metrics": lambda a: observability.metrics(a["service"], a.get("minutes", 30)),
    "search_logs": lambda a: observability.logs(a.get("query", ""), a.get("service"), a.get("level"), a.get("limit", 50)),
}


@app.post("/tools/{name}")
async def call_tool(name: str, request: Request) -> dict:
    body = await request.body()
    if SECRET and not verify(SECRET, request.headers.get("X-Agents-Signature", ""), body):
        raise HTTPException(401, "bad signature")
    if name not in HANDLERS:
        raise HTTPException(404, f"unknown tool {name}")
    payload = await request.json()
    return {"result": HANDLERS[name](payload.get("arguments", {}))}
