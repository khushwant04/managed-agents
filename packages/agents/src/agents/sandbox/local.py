"""A sandbox in a local temporary directory.

For tests and quick local runs only: commands run as the current user with no
isolation beyond the working directory. ``/workspace`` in commands and paths
is mapped onto the directory. Use Docker or E2B for anything untrusted.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
import uuid
from pathlib import Path

from .base import (
    WORKSPACE,
    WORKSPACE_DIRS,
    Environment,
    ExecResult,
    FileSpec,
    SandboxError,
    SandboxHandle,
    workspace_path,
)


class LocalSandboxProvider:
    name = "local"

    def __init__(self, root: str | None = None) -> None:
        self.root = Path(root) if root else Path(tempfile.gettempdir()) / "agents-sandboxes"

    def _dir(self, h: SandboxHandle) -> Path:
        return Path(h.data["dir"])

    def _host_path(self, h: SandboxHandle, path: str) -> Path:
        rel = workspace_path(path)[len(WORKSPACE) :].lstrip("/")
        return self._dir(h) / rel

    async def create(self, env: Environment) -> SandboxHandle:
        sid = f"local-{uuid.uuid4().hex[:12]}"
        d = self.root / sid
        for sub in WORKSPACE_DIRS:
            (d / sub).mkdir(parents=True, exist_ok=True)
        return SandboxHandle(id=sid, provider="local", data={"dir": str(d), "env": env.env})

    async def exec(self, h: SandboxHandle, cmd: str, timeout: float | None = None) -> ExecResult:
        d = self._dir(h)
        if not d.exists():
            raise SandboxError(f"sandbox {h.id} does not exist")
        cmd = cmd.replace(WORKSPACE, str(d))
        env = {**os.environ, **h.data.get("env", {}), "HOME": str(d), "WORKSPACE": str(d)}
        proc = await asyncio.create_subprocess_exec(
            "bash",
            "-c",
            cmd,
            cwd=d,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except TimeoutError:
            proc.kill()
            out, err = await proc.communicate()
            return ExecResult(exit_code=-1, stdout=out.decode(errors="replace"), stderr=err.decode(errors="replace"), timed_out=True)
        return ExecResult(
            exit_code=proc.returncode if proc.returncode is not None else -1,
            stdout=out.decode(errors="replace"),
            stderr=err.decode(errors="replace"),
        )

    async def write_files(self, h: SandboxHandle, files: list[FileSpec]) -> None:
        for f in files:
            p = self._host_path(h, f.path)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(f.content)

    async def read_files(self, h: SandboxHandle, paths: list[str]) -> list[FileSpec]:
        out = []
        for path in paths:
            p = self._host_path(h, path)
            if not p.is_file():
                raise SandboxError(f"no such file: {workspace_path(path)}")
            out.append(FileSpec(path=workspace_path(path), content=p.read_bytes()))
        return out

    async def list_files(self, h: SandboxHandle, path: str) -> list[str]:
        base = self._host_path(h, path)
        if not base.exists():
            return []
        d = self._dir(h)
        return sorted(
            WORKSPACE + "/" + str(p.relative_to(d)) for p in base.rglob("*") if p.is_file()
        )

    async def pause(self, h: SandboxHandle) -> None:
        return None

    async def resume(self, h: SandboxHandle) -> SandboxHandle:
        if not self._dir(h).exists():
            raise SandboxError(f"sandbox {h.id} no longer exists")
        return h

    async def destroy(self, h: SandboxHandle) -> None:
        shutil.rmtree(self._dir(h), ignore_errors=True)
