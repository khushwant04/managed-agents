"""In-process stores for the embedded runtime and tests."""

from __future__ import annotations

import asyncio
import itertools
from collections import defaultdict
from collections.abc import AsyncIterator
from typing import Any

from ..events import Event, new_id, utcnow
from .base import Step, StepSpec


class InMemoryStepStore:
    def __init__(self) -> None:
        self._steps: dict[str, Step] = {}
        self._by_key: dict[tuple[str, str], str] = {}
        self._seq = itertools.count(1)

    async def begin(self, step: StepSpec) -> str:
        existing = self._by_key.get((step.run_id, step.key))
        if existing is not None:
            row = self._steps[existing]
            if row.status != "completed":
                row.attempts += 1
                row.status = "begun"
            return existing
        sid = new_id("step")
        self._steps[sid] = Step(id=sid, seq=next(self._seq), **step.model_dump())
        self._by_key[(step.run_id, step.key)] = sid
        return sid

    async def complete(self, step_id: str, output: dict[str, Any]) -> None:
        row = self._steps[step_id]
        row.status, row.output, row.completed_at = "completed", output, utcnow()

    async def fail(self, step_id: str, error: str) -> None:
        row = self._steps[step_id]
        row.status, row.error = "failed", error

    async def get(self, run_id: str, key: str) -> Step | None:
        sid = self._by_key.get((run_id, key))
        return self._steps[sid].model_copy() if sid else None

    async def last_completed(self, run_id: str) -> Step | None:
        done = [s for s in self._steps.values() if s.run_id == run_id and s.status == "completed"]
        return max(done, key=lambda s: s.seq).model_copy() if done else None

    async def session_steps(self, session_id: str) -> list[Step]:
        rows = [s for s in self._steps.values() if s.session_id == session_id and s.status == "completed"]
        return [s.model_copy() for s in sorted(rows, key=lambda s: s.seq)]

    async def run_steps(self, run_id: str) -> list[Step]:
        rows = [s for s in self._steps.values() if s.run_id == run_id]
        return [s.model_copy() for s in sorted(rows, key=lambda s: s.seq)]


class InMemoryEventLog:
    def __init__(self) -> None:
        self._events: dict[str, list[Event]] = defaultdict(list)
        self._cond: dict[str, asyncio.Condition] = {}
        self._closed: set[str] = set()

    def _condition(self, session_id: str) -> asyncio.Condition:
        if session_id not in self._cond:
            self._cond[session_id] = asyncio.Condition()
        return self._cond[session_id]

    async def append(self, event: Event) -> Event:
        log = self._events[event.session_id]
        event = event.model_copy(update={"seq": len(log) + 1})
        log.append(event)
        cond = self._condition(event.session_id)
        async with cond:
            cond.notify_all()
        return event

    async def read(self, session_id: str, after_seq: int = 0, limit: int | None = None) -> list[Event]:
        events = self._events[session_id][after_seq:]
        return events[:limit] if limit is not None else list(events)

    async def close(self, session_id: str) -> None:
        """Stop live subscriptions for a session once it is finished."""
        self._closed.add(session_id)
        cond = self._condition(session_id)
        async with cond:
            cond.notify_all()

    async def subscribe(self, session_id: str, after_seq: int = 0) -> AsyncIterator[Event]:
        cond = self._condition(session_id)
        seq = after_seq
        while True:
            events = self._events[session_id][seq:]
            for ev in events:
                seq = ev.seq
                yield ev
            if session_id in self._closed and seq >= len(self._events[session_id]):
                return
            async with cond:
                if seq >= len(self._events[session_id]) and session_id not in self._closed:
                    await cond.wait()
