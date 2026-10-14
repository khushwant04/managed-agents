"""The model adapter contract (ADR-0003)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Literal, Protocol, runtime_checkable

from ..types import CapabilityManifest, ModelDelta, ModelRequest, Vendor

ModelErrorKind = Literal["rate_limit", "server", "connection", "refusal", "bad_request", "auth"]


class ModelError(Exception):
    """A failed model call, classified so the router can decide on a fallback.

    Per the routing rules (ADR-0007), the next model in the agent's list is
    tried on 429, 5xx, connection errors and refusals; bad requests and auth
    failures are not retried on another model.
    """

    def __init__(self, kind: ModelErrorKind, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.kind = kind
        self.status = status

    @property
    def should_fall_back(self) -> bool:
        return self.kind in ("rate_limit", "server", "connection", "refusal")


@runtime_checkable
class ModelAdapter(Protocol):
    id: Vendor

    def capabilities(self, model: str) -> CapabilityManifest: ...

    def stream(self, req: ModelRequest) -> AsyncIterator[ModelDelta]:
        """Stream text, thinking and tool-call deltas, ending with one ``ModelResponse``."""
        ...
