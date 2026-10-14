"""Derives a session's transcript from its completed steps."""

from __future__ import annotations

from collections.abc import Iterable

from ..store.base import Step
from ..types import Message, ToolResultBlock


class TranscriptBuilder:
    """Folds steps into messages.

    Tool results for one assistant message are grouped into a single user
    message, in the order the calls were made (parallel calls may complete in
    any order). Steering input that follows them joins the same user message.
    """

    def __init__(self, messages: list[Message] | None = None) -> None:
        self.messages: list[Message] = list(messages or [])
        self._pending: dict[str, ToolResultBlock] = {}
        self._call_order: list[str] = []

    def add(self, step: Step) -> None:
        out = step.output or {}
        if step.type == "tool":
            result = ToolResultBlock.model_validate(out["result"])
            self._pending[result.call_id] = result
            return
        if step.type == "approval":
            return
        self.flush()
        if step.type == "input":
            for m in out.get("messages", []):
                self.append(Message.model_validate(m))
        elif step.type == "model":
            message = Message.model_validate(out["message"])
            self.messages.append(message)
            self._call_order = [c.id for c in message.tool_calls]
        elif step.type == "compaction":
            self.messages = [Message.model_validate(m) for m in out.get("messages", [])]
            self._call_order = []

    def add_results(self, results: Iterable[ToolResultBlock]) -> None:
        for r in results:
            self._pending[r.call_id] = r

    def flush(self) -> None:
        if not self._pending:
            return
        ordered = [self._pending.pop(cid) for cid in self._call_order if cid in self._pending]
        ordered += list(self._pending.values())
        self._pending.clear()
        self._call_order = []
        self.append(Message(role="user", content=list(ordered)))

    def append(self, message: Message) -> None:
        if self.messages and self.messages[-1].role == message.role == "user":
            last = self.messages[-1]
            self.messages[-1] = Message(role="user", content=[*last.content, *message.content])
        else:
            self.messages.append(message)

    def build(self) -> list[Message]:
        self.flush()
        return list(self.messages)


def build_transcript(steps: Iterable[Step]) -> list[Message]:
    b = TranscriptBuilder()
    for s in steps:
        b.add(s)
    return b.build()
