"""Normalized session events (ADR-0008).

Every event carries ``id``, ``session_id``, ``run_id``, ``seq`` (monotonic per
session), ``type``, ``ts``, ``model`` and ``payload``. Local and hosted sessions
emit the same types, so client code works unchanged in both.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

EventType = Literal[
    "session.status",
    "route.resolved",
    "run.started",
    "run.finished",
    "message.user",
    "message.agent.delta",
    "message.agent.done",
    "thinking.delta",
    "tool.call",
    "tool.result",
    "tool.approval.requested",
    "tool.approval.decided",
    "subagent.started",
    "subagent.finished",
    "artifact.created",
    "error",
]

EVENT_TYPES: frozenset[str] = frozenset(EventType.__args__)  # type: ignore[attr-defined]

SessionStatus = Literal[
    "queued", "running", "waiting_input", "approval_pending", "idle", "failed", "terminated"
]

RunStopReason = Literal["end_turn", "needs_input", "approval_pending", "budget", "interrupted", "error"]


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def utcnow() -> datetime:
    return datetime.now(UTC)


class Event(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    id: str = Field(default_factory=lambda: new_id("evt"))
    session_id: str
    run_id: str | None = None
    seq: int = 0
    type: EventType
    ts: datetime = Field(default_factory=utcnow)
    model: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)

    @property
    def text(self) -> str:
        """Convenience for ``message.agent.delta`` / ``thinking.delta`` events."""
        return str(self.payload.get("text", ""))

    def to_sse(self) -> str:
        return f"id: {self.seq}\nevent: {self.type}\ndata: {self.model_dump_json()}\n\n"
