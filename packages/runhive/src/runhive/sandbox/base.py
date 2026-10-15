"""The sandbox provider contract (ADR-0006).

Every session gets its own sandbox. Workers drive it through command and file
APIs; nothing agent-specific runs inside it. Paths the model sees are rooted at
``/workspace``:

    /workspace/inputs   files provided with the input
    /workspace/outputs  synced to object storage as artifacts
    /workspace/skills   one folder per skill
    /workspace/memory   the agent's memory store
"""

from __future__ import annotations

import base64
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, Field, field_serializer, field_validator

WORKSPACE = "/workspace"
WORKSPACE_DIRS = ("inputs", "outputs", "skills", "memory")

ProviderName = Literal["local", "docker", "e2b"]


class Environment(BaseModel):
    """A sandbox template: provider, image or template, and limits."""

    name: str = "default"
    provider: ProviderName = "e2b"
    template: str = "runhive-base"
    timeout_s: int = 3600
    cpu: int | None = None
    memory_mb: int | None = None
    allow_internet: bool = True
    allowed_hosts: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    """Non-secret environment variables. Secrets never enter the sandbox (ADR-0010)."""


class SandboxHandle(BaseModel):
    id: str
    provider: ProviderName
    data: dict[str, Any] = Field(default_factory=dict)


class ExecResult(BaseModel):
    exit_code: int
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False

    def render(self, limit: int = 30_000) -> str:
        """Format as a tool result, keeping the tail of long output."""
        parts = []
        if self.stdout:
            parts.append(self.stdout)
        if self.stderr:
            parts.append(f"[stderr]\n{self.stderr}")
        if self.timed_out:
            parts.append("[timed out]")
        parts.append(f"[exit code {self.exit_code}]")
        text = "\n".join(parts)
        if len(text) > limit:
            text = f"[... {len(text) - limit} characters truncated]\n" + text[-limit:]
        return text


class FileSpec(BaseModel):
    path: str
    content: bytes

    @field_serializer("content")
    def _encode(self, value: bytes) -> str:
        return base64.b64encode(value).decode()

    @field_validator("content", mode="before")
    @classmethod
    def _decode(cls, value: Any) -> bytes:
        if isinstance(value, str):
            try:
                return base64.b64decode(value, validate=True)
            except ValueError:
                return value.encode()
        return value

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", errors="replace")


class SandboxError(Exception):
    pass


@runtime_checkable
class SandboxProvider(Protocol):
    name: ProviderName

    async def create(self, env: Environment) -> SandboxHandle: ...

    async def exec(self, h: SandboxHandle, cmd: str, timeout: float | None = None) -> ExecResult: ...

    async def write_files(self, h: SandboxHandle, files: list[FileSpec]) -> None: ...

    async def read_files(self, h: SandboxHandle, paths: list[str]) -> list[FileSpec]: ...

    async def pause(self, h: SandboxHandle) -> None:
        """Optional: pause an idle sandbox. Providers without pause may no-op."""
        ...

    async def resume(self, h: SandboxHandle) -> SandboxHandle:
        """Reconnect to a paused or existing sandbox; may return a new handle."""
        ...

    async def destroy(self, h: SandboxHandle) -> None: ...


def workspace_path(path: str) -> str:
    """Normalize a model-supplied path to an absolute path under /workspace."""
    import posixpath

    if not path.startswith("/"):
        path = posixpath.join(WORKSPACE, path)
    norm = posixpath.normpath(path)
    if norm != WORKSPACE and not norm.startswith(WORKSPACE + "/"):
        raise SandboxError(f"path {path!r} is outside {WORKSPACE}")
    return norm
