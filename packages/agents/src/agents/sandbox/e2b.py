"""E2B sandboxes: one Firecracker microVM per session (ADR-0006).

Requires the ``e2b`` extra and ``E2B_API_KEY``. Sandboxes are created from the
``agents-base`` template (see ``infra/e2b``); idle sessions are paused and
reconnected on the next input, which resumes them.
"""

from __future__ import annotations

from typing import Any

from .base import (
    WORKSPACE,
    WORKSPACE_DIRS,
    Environment,
    ExecResult,
    FileSpec,
    SandboxError,
    SandboxHandle,
)


class E2BSandboxProvider:
    name = "e2b"

    def __init__(self, api_key: str | None = None) -> None:
        try:
            from e2b import AsyncSandbox
        except ImportError as exc:  # pragma: no cover
            raise ImportError("E2B sandboxes need the e2b extra: pip install 'managed-agents[e2b]'") from exc
        self._cls = AsyncSandbox
        self._api_key = api_key
        self._live: dict[str, Any] = {}

    def _opts(self) -> dict[str, Any]:
        return {"api_key": self._api_key} if self._api_key else {}

    async def _sbx(self, h: SandboxHandle) -> Any:
        sbx = self._live.get(h.id)
        if sbx is None:
            sbx = await self._cls.connect(h.id, timeout=h.data.get("timeout_s"), **self._opts())
            self._live[h.id] = sbx
        return sbx

    async def create(self, env: Environment) -> SandboxHandle:
        kwargs: dict[str, Any] = {
            "template": env.template,
            "timeout": env.timeout_s,
            "envs": env.env,
            "metadata": {"environment": env.name},
            **self._opts(),
        }
        if env.allowed_hosts:
            kwargs["network"] = {"allow_out": env.allowed_hosts, "deny_out": ["0.0.0.0/0"]}
        elif not env.allow_internet:
            kwargs["allow_internet_access"] = False
        sbx = await self._cls.create(**kwargs)
        self._live[sbx.sandbox_id] = sbx
        dirs = " ".join(f"{WORKSPACE}/{d}" for d in WORKSPACE_DIRS)
        await sbx.commands.run(f"mkdir -p {dirs}", timeout=30)
        return SandboxHandle(id=sbx.sandbox_id, provider="e2b", data={"timeout_s": env.timeout_s})

    async def exec(self, h: SandboxHandle, cmd: str, timeout: float | None = None) -> ExecResult:
        from e2b import CommandExitException, TimeoutException

        sbx = await self._sbx(h)
        try:
            r = await sbx.commands.run(cmd, cwd=WORKSPACE, timeout=timeout or 120)
            return ExecResult(exit_code=r.exit_code, stdout=r.stdout, stderr=r.stderr)
        except CommandExitException as r:
            return ExecResult(exit_code=r.exit_code, stdout=r.stdout, stderr=r.stderr)
        except TimeoutException as exc:
            return ExecResult(exit_code=-1, stderr=str(exc), timed_out=True)

    async def write_files(self, h: SandboxHandle, files: list[FileSpec]) -> None:
        sbx = await self._sbx(h)
        for f in files:
            await sbx.files.write(f.path, f.content)

    async def read_files(self, h: SandboxHandle, paths: list[str]) -> list[FileSpec]:
        sbx = await self._sbx(h)
        out = []
        for path in paths:
            try:
                data = await sbx.files.read(path, format="bytes")
            except Exception as exc:  # the SDK raises NotFoundException and friends
                raise SandboxError(f"cannot read {path}: {exc}") from exc
            out.append(FileSpec(path=path, content=bytes(data)))
        return out

    async def pause(self, h: SandboxHandle) -> None:
        sbx = self._live.pop(h.id, None)
        if sbx is not None:
            await sbx.pause()
        else:
            await self._cls.pause(h.id, **self._opts())

    async def resume(self, h: SandboxHandle) -> SandboxHandle:
        self._live.pop(h.id, None)
        await self._sbx(h)
        return h

    async def destroy(self, h: SandboxHandle) -> None:
        sbx = self._live.pop(h.id, None)
        if sbx is not None:
            await sbx.kill()
        else:
            await self._cls.kill(h.id, **self._opts())
