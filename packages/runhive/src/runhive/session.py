"""Local session handles: ``AsyncSession`` and its sync wrapper ``Session``.

``events()`` yields the session's events until the current run settles
(idle, waiting for input or approval, failed); call it again after ``send()``
or ``approve()`` to follow the next run. Hosted sessions from ``Client``
expose the same methods and events.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator, Coroutine, Iterator
from typing import TYPE_CHECKING, Any, TypeVar

from .events import Event
from .runtime.local import SETTLED, LocalRuntime
from .runtime.runner import RunResult
from .sandbox import Sandbox
from .sandbox.base import FileSpec

if TYPE_CHECKING:
    from .adapters import AdapterRegistry
    from .agent import Agent

T = TypeVar("T")


class AsyncSession:
    def __init__(self, runtime: LocalRuntime, session_id: str) -> None:
        self.runtime = runtime
        self.id = session_id
        self._cursor = 0

    @classmethod
    async def start(
        cls,
        agent: Agent,
        input: str | None = None,
        *,
        sandbox: Sandbox | None = None,
        adapters: AdapterRegistry | None = None,
        runtime: LocalRuntime | None = None,
    ) -> AsyncSession:
        runtime = runtime or LocalRuntime(adapters=adapters)
        sid = await runtime.create_session(
            agent.spec(), functions=agent.functions, skills=agent.skills, sandbox=sandbox, agents=agent.agents
        )
        session = cls(runtime, sid)
        if input is not None:
            await session.send(input)
        return session

    async def send(self, text: str) -> None:
        await self.runtime.send(self.id, text)

    async def events(self) -> AsyncIterator[Event]:
        """Events since the last call, until the current run settles."""
        running = False
        async for ev in self.runtime.stream(self.id, self._cursor):
            self._cursor = ev.seq
            yield ev
            if ev.type == "session.status":
                status = ev.payload.get("status")
                if status == "running":
                    running = True
                elif running and status in SETTLED:
                    return
                elif status == "terminated":
                    return

    async def history(self) -> list[Event]:
        return await self.runtime.events.read(self.id)

    async def wait(self) -> RunResult | None:
        return await self.runtime.wait(self.id)

    async def approve(self, call_id: str, approved: bool = True, reason: str | None = None) -> None:
        await self.runtime.approve(self.id, call_id, approved, reason)

    async def deny(self, call_id: str, reason: str | None = None) -> None:
        await self.approve(call_id, False, reason)

    async def interrupt(self) -> None:
        await self.runtime.interrupt(self.id)

    async def artifacts(self) -> list[FileSpec]:
        return await self.runtime.read_outputs(self.id)

    async def close(self) -> None:
        await self.runtime.close(self.id)

    @property
    def result(self) -> RunResult | None:
        return self.runtime.sessions[self.id].last_result

    @property
    def output(self) -> str:
        return self.result.output if self.result else ""

    @property
    def status(self) -> str:
        return self.runtime.sessions[self.id].status

    async def __aenter__(self) -> AsyncSession:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()


class _LoopThread:
    """A private event loop on a daemon thread, for the sync API."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, name="agents-session", daemon=True)
        self.thread.start()

    def call(self, coro: Coroutine[Any, Any, T]) -> T:
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result()

    def stop(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)


class Session:
    """Synchronous wrapper around ``AsyncSession``."""

    def __init__(self, inner: AsyncSession, loop: _LoopThread) -> None:
        self._inner = inner
        self._loop = loop

    @classmethod
    def start(
        cls,
        agent: Agent,
        input: str | None = None,
        *,
        sandbox: Sandbox | None = None,
        adapters: AdapterRegistry | None = None,
    ) -> Session:
        loop = _LoopThread()
        inner = loop.call(AsyncSession.start(agent, input, sandbox=sandbox, adapters=adapters))
        return cls(inner, loop)

    @property
    def id(self) -> str:
        return self._inner.id

    def events(self) -> Iterator[Event]:
        agen = self._inner.events()
        while True:
            try:
                yield self._loop.call(agen.__anext__())
            except StopAsyncIteration:
                return

    def send(self, text: str) -> None:
        self._loop.call(self._inner.send(text))

    def wait(self) -> RunResult | None:
        return self._loop.call(self._inner.wait())

    def approve(self, call_id: str, approved: bool = True, reason: str | None = None) -> None:
        self._loop.call(self._inner.approve(call_id, approved, reason))

    def deny(self, call_id: str, reason: str | None = None) -> None:
        self.approve(call_id, False, reason)

    def interrupt(self) -> None:
        self._loop.call(self._inner.interrupt())

    def artifacts(self) -> list[FileSpec]:
        return self._loop.call(self._inner.artifacts())

    def history(self) -> list[Event]:
        return self._loop.call(self._inner.history())

    @property
    def result(self) -> RunResult | None:
        return self._inner.result

    @property
    def output(self) -> str:
        return self._inner.output

    @property
    def status(self) -> str:
        return self._inner.status

    def close(self) -> None:
        try:
            self._loop.call(self._inner.close())
        finally:
            self._loop.stop()

    def __enter__(self) -> Session:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
