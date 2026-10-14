"""Sandbox providers (ADR-0006): E2B by default, Docker for development, local for tests."""

from __future__ import annotations

from .base import Environment, ExecResult, FileSpec, SandboxError, SandboxHandle, SandboxProvider
from .local import LocalSandboxProvider


class Sandbox:
    """Factory used by ``Agent.start(sandbox=...)``."""

    def __init__(self, provider: SandboxProvider, env: Environment | None = None) -> None:
        self.provider = provider
        self.env = env or Environment(provider=provider.name)

    @classmethod
    def e2b(cls, template: str = "agents-base", *, api_key: str | None = None, **env: object) -> Sandbox:
        from .e2b import E2BSandboxProvider

        return cls(E2BSandboxProvider(api_key=api_key), Environment(provider="e2b", template=template, **env))  # type: ignore[arg-type]

    @classmethod
    def docker(cls, image: str = "agents-base:latest", **env: object) -> Sandbox:
        from .docker import DockerSandboxProvider

        return cls(DockerSandboxProvider(image=image), Environment(provider="docker", template=image, **env))  # type: ignore[arg-type]

    @classmethod
    def local(cls, root: str | None = None, **env: object) -> Sandbox:
        return cls(LocalSandboxProvider(root=root), Environment(provider="local", **env))  # type: ignore[arg-type]


def provider_for(env: Environment, **kwargs: object) -> SandboxProvider:
    if env.provider == "e2b":
        from .e2b import E2BSandboxProvider

        return E2BSandboxProvider(**kwargs)  # type: ignore[arg-type]
    if env.provider == "docker":
        from .docker import DockerSandboxProvider

        return DockerSandboxProvider(**kwargs)  # type: ignore[arg-type]
    return LocalSandboxProvider(**kwargs)  # type: ignore[arg-type]


__all__ = [
    "Environment",
    "ExecResult",
    "FileSpec",
    "Sandbox",
    "SandboxError",
    "SandboxHandle",
    "SandboxProvider",
    "provider_for",
]
