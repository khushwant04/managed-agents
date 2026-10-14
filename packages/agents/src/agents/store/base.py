"""Durable execution contracts (ADR-0005, ADR-0008).

Every model call, tool call, input and compaction is a **step**, written
before and after it runs under an idempotency key unique within its run. A
run is deterministic given its completed steps, so a resumed run replays them
instead of re-executing: a completed tool call is never repeated, and a tool
call that began but did not complete is retried with the same key so webhook
receivers can deduplicate.

The session transcript is derived from the completed steps of all its runs
(see ``runtime.transcript``), so there is no second copy to keep in sync.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, Field

from ..events import Event, utcnow

StepType = Literal["input", "model", "tool", "approval", "compaction"]
StepStatus = Literal["begun", "completed", "failed"]


class StepSpec(BaseModel):
    session_id: str
    run_id: str
    key: str
    type: StepType
    input: dict[str, Any] = Field(default_factory=dict)


class Step(StepSpec):
    id: str
    seq: int
    status: StepStatus = "begun"
    output: dict[str, Any] | None = None
    error: str | None = None
    attempts: int = 1
    created_at: datetime = Field(default_factory=utcnow)
    completed_at: datetime | None = None


@runtime_checkable
class StepStore(Protocol):
    async def begin(self, step: StepSpec) -> str:
        """Record that a step is starting. Re-beginning an existing key returns its id."""
        ...

    async def complete(self, step_id: str, output: dict[str, Any]) -> None: ...

    async def fail(self, step_id: str, error: str) -> None: ...

    async def get(self, run_id: str, key: str) -> Step | None: ...

    async def last_completed(self, run_id: str) -> Step | None: ...

    async def session_steps(self, session_id: str) -> list[Step]:
        """All completed steps of a session, in order."""
        ...


@runtime_checkable
class EventLog(Protocol):
    async def append(self, event: Event) -> Event:
        """Assign the next ``seq`` for the session, persist, and fan out."""
        ...

    async def read(self, session_id: str, after_seq: int = 0, limit: int | None = None) -> list[Event]: ...

    def subscribe(self, session_id: str, after_seq: int = 0) -> AsyncIterator[Event]:
        """Replay events after ``after_seq``, then follow live ones."""
        ...
