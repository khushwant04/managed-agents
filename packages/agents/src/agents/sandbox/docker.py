"""Docker sandboxes for local development (ADR-0006).

One container per session from the ``agents-base`` image (build it from
``infra/e2b/Dockerfile``, or set ``image``). Uses the ``docker`` CLI, so no
extra Python dependency is needed. Docker is weaker isolation than E2B's
microVMs; use it for development, not for untrusted multi-tenant workloads.
"""

from __future__ import annotations

import asyncio
import io
import posixpath
import tarfile
import uuid

from .base import (
    WORKSPACE,
    WORKSPACE_DIRS,
    Environment,
    ExecResult,
    FileSpec,
    SandboxError,
    SandboxHandle,
)


async def _docker(*args: str, stdin: bytes | None = None, timeout: float | None = None) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        "docker",
        *args,
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(stdin), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.communicate()
        raise
    return proc.returncode or 0, out, err


class DockerSandboxProvider:
    name = "docker"

    def __init__(self, image: str = "agents-base:latest") -> None:
        self.image = image

    async def create(self, env: Environment) -> SandboxHandle:
        name = f"agents-{uuid.uuid4().hex[:12]}"
        args = ["run", "-d", "--name", name, "--label", "managed-agents=1", "-w", WORKSPACE]
        if env.memory_mb:
            args += ["--memory", f"{env.memory_mb}m"]
        if env.cpu:
            args += ["--cpus", str(env.cpu)]
        if not env.allow_internet:
            args += ["--network", "none"]
        for k, v in env.env.items():
            args += ["-e", f"{k}={v}"]
        image = env.template if ":" in env.template or "/" in env.template else self.image
        args += [image, "sleep", str(env.timeout_s)]
        code, out, err = await _docker(*args)
        if code != 0:
            raise SandboxError(f"docker run failed: {err.decode().strip()}")
        dirs = " ".join(f"{WORKSPACE}/{d}" for d in WORKSPACE_DIRS)
        await _docker("exec", name, "mkdir", "-p", *dirs.split())
        return SandboxHandle(id=name, provider="docker")

    async def exec(self, h: SandboxHandle, cmd: str, timeout: float | None = None) -> ExecResult:
        try:
            code, out, err = await _docker("exec", "-w", WORKSPACE, h.id, "bash", "-lc", cmd, timeout=timeout)
        except TimeoutError:
            return ExecResult(exit_code=-1, timed_out=True)
        return ExecResult(exit_code=code, stdout=out.decode(errors="replace"), stderr=err.decode(errors="replace"))

    async def write_files(self, h: SandboxHandle, files: list[FileSpec]) -> None:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            for f in files:
                info = tarfile.TarInfo(name=f.path.lstrip("/"))
                info.size = len(f.content)
                tar.addfile(info, io.BytesIO(f.content))
        code, _, err = await _docker("cp", "-", f"{h.id}:/", stdin=buf.getvalue())
        if code != 0:
            raise SandboxError(f"docker cp failed: {err.decode().strip()}")

    async def read_files(self, h: SandboxHandle, paths: list[str]) -> list[FileSpec]:
        out = []
        for path in paths:
            code, data, err = await _docker("cp", f"{h.id}:{path}", "-")
            if code != 0:
                raise SandboxError(f"cannot read {path}: {err.decode().strip()}")
            with tarfile.open(fileobj=io.BytesIO(data)) as tar:
                member = tar.extractfile(posixpath.basename(path))
                if member is None:
                    raise SandboxError(f"{path} is not a regular file")
                out.append(FileSpec(path=path, content=member.read()))
        return out

    async def pause(self, h: SandboxHandle) -> None:
        await _docker("pause", h.id)

    async def resume(self, h: SandboxHandle) -> SandboxHandle:
        await _docker("unpause", h.id)
        return h

    async def destroy(self, h: SandboxHandle) -> None:
        await _docker("rm", "-f", h.id)
