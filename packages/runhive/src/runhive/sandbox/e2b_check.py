"""End-to-end check of an E2B setup for this platform.

Works against E2B Cloud and against a self-hosted E2B runtime such as E2B
Embed (https://github.com/e2b-dev/runtime). It goes through the same code the
runtime uses (``E2BSandboxProvider`` and the built-in tools), so a pass means
agents will run, not just that the SDK can reach the API:

    runhive e2b check                          # template runhive-base, E2B Cloud or E2B_API_URL
    runhive e2b check --template base          # a stock template (tool checks become warnings)
    runhive e2b check --egress                 # also check the egress allowlist

Each step prints ``ok``, ``warn`` or ``FAIL``; failures carry a ``FIX:`` line.
"""

from __future__ import annotations

import os
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from .base import WORKSPACE, WORKSPACE_DIRS, Environment, FileSpec, SandboxHandle

Status = Literal["ok", "warn", "fail", "skip"]
CLOUD_API = "https://api.e2b.app"


@dataclass
class Step:
    name: str
    status: Status
    detail: str = ""
    fix: str = ""
    seconds: float = 0.0


@dataclass
class Report:
    api_url: str
    template: str
    self_hosted: bool
    steps: list[Step] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(s.status != "fail" for s in self.steps)

    def render(self) -> str:
        mode = f"self-hosted at {self.api_url}" if self.self_hosted else "E2B Cloud"
        lines = [f"E2B setup check: {mode}, template {self.template!r}"]
        for s in self.steps:
            mark = {"ok": "ok  ", "warn": "warn", "fail": "FAIL", "skip": "skip"}[s.status]
            timing = f" ({s.seconds:.1f}s)" if s.seconds >= 0.05 else ""
            lines.append(f"  {mark} {s.name}{timing}" + (f": {s.detail}" if s.detail else ""))
            if s.fix:
                lines.append(f"       FIX: {s.fix}")
        passed = sum(s.status == "ok" for s in self.steps)
        lines.append(f"{'PASS' if self.ok else 'FAIL'}: {passed}/{len(self.steps)} checks passed")
        return "\n".join(lines)


class _Fail(Exception):
    def __init__(self, detail: str, fix: str = "") -> None:
        super().__init__(detail)
        self.detail, self.fix = detail, fix


class _Warn(Exception):
    def __init__(self, detail: str, fix: str = "") -> None:
        super().__init__(detail)
        self.detail, self.fix = detail, fix


async def check_e2b(
    *,
    template: str = "runhive-base",
    api_key: str | None = None,
    api_url: str | None = None,
    sandbox_url: str | None = None,
    egress: bool = False,
    pause: bool = True,
    timeout_s: int = 300,
    http: Any = None,
) -> Report:
    import httpx

    from .e2b import E2BSandboxProvider

    api_key = api_key or os.environ.get("E2B_API_KEY")
    api_url = (api_url or os.environ.get("E2B_API_URL") or "").rstrip("/")
    sandbox_url = sandbox_url or os.environ.get("E2B_SANDBOX_URL")
    report = Report(api_url=api_url or CLOUD_API, template=template, self_hosted=bool(api_url))
    strict_tools = template == "runhive-base"

    async def step(name: str, fn: Callable[[], Awaitable[str | None]]) -> bool:
        started = time.monotonic()
        try:
            detail = await fn() or ""
            report.steps.append(Step(name, "ok", detail, seconds=time.monotonic() - started))
            return True
        except _Warn as w:
            report.steps.append(Step(name, "warn", w.detail, w.fix, time.monotonic() - started))
            return True
        except _Fail as f:
            report.steps.append(Step(name, "fail", f.detail, f.fix, time.monotonic() - started))
        except Exception as exc:
            report.steps.append(Step(name, "fail", f"{type(exc).__name__}: {exc}", seconds=time.monotonic() - started))
        return False

    def skip(*names: str) -> None:
        report.steps.extend(Step(n, "skip", "an earlier check failed") for n in names)

    # 1. Configuration --------------------------------------------------------
    async def config() -> str:
        if not api_key:
            raise _Fail("E2B_API_KEY is not set", "export E2B_API_KEY (on E2B Embed: eval \"$(docker compose exec ready cat /run/e2b/sdk.env)\")")
        if api_url and not sandbox_url:
            raise _Fail(
                "E2B_API_URL is set but E2B_SANDBOX_URL is not; a self-hosted runtime needs both",
                "export E2B_SANDBOX_URL (on E2B Embed it is http://<host>:3002)",
            )
        return "self-hosted" if api_url else "E2B Cloud"

    if not await step("configuration", config):
        skip("api reachable", "template ready", "create sandbox")
        return report

    # 2. API and key ------------------------------------------------------------
    templates: list[dict[str, Any]] = []
    base = api_url or CLOUD_API

    async def api() -> str:
        nonlocal templates
        client = http or httpx.AsyncClient(timeout=30)
        headers = {"X-API-Key": api_key or ""}
        try:
            # GET /v2/templates is paginated with X-Next-Token; older installs only have /templates.
            resp = await client.get(f"{base}/v2/templates", headers=headers, params={"limit": 100})
            if resp.status_code == 404:
                resp = await client.get(f"{base}/templates", headers=headers)
            while resp.status_code == 200:
                templates += resp.json()
                token = resp.headers.get("X-Next-Token")
                if not token:
                    break
                resp = await client.get(f"{base}/v2/templates", headers=headers, params={"limit": 100, "nextToken": token})
        except httpx.HTTPError as exc:
            raise _Fail(f"cannot reach {base}: {exc}", "check E2B_API_URL and that the API port (3000 on Embed) is reachable") from exc
        finally:
            if http is None:
                await client.aclose()
        if resp.status_code in (401, 403):
            raise _Fail(f"{resp.status_code} from {base}", "the API key is wrong for this install; re-export E2B_API_KEY")
        if resp.status_code != 200:
            raise _Fail(f"{resp.status_code} from {base}: {resp.text[:200]}")
        return f"{len(templates)} template(s) visible"

    if not await step("api reachable", api):
        skip("template ready", "create sandbox")
        return report

    # 3. Template ---------------------------------------------------------------
    async def template_ready() -> str:
        names = lambda t: {*(t.get("aliases") or []), *(t.get("names") or []), t.get("templateID")}  # noqa: E731
        match = [t for t in templates if template in names(t)]
        build_fix = (
            "build it: E2B_API_URL=... E2B_API_KEY=... uv run --no-project --with 'e2b>=2' python infra/e2b/build_template.py"
            if template == "runhive-base"
            else f"build or alias a template named {template!r}"
        )
        if not match:
            raise _Fail(f"no template named {template!r}", build_fix)
        status = match[0].get("buildStatus")
        if status not in (None, "ready"):
            raise _Fail(f"template {template!r} build status is {status!r}", build_fix)
        return f"{match[0].get('templateID')} ({status or 'ready'})"

    if not await step("template ready", template_ready):
        skip("create sandbox")
        return report

    # 4. Sandbox lifecycle through the provider -------------------------------------
    provider = E2BSandboxProvider(api_key=api_key, api_url=api_url or None, sandbox_url=sandbox_url)
    env = Environment(name="e2b-check", provider="e2b", template=template, timeout_s=timeout_s)
    handle: SandboxHandle | None = None

    async def create() -> str:
        nonlocal handle
        try:
            handle = await provider.create(env)
        except Exception as exc:
            fix = (
                "read the api and orchestrator logs (docker compose logs api orchestrator); "
                "'Failed to place sandbox' usually means HUGEPAGES or NBDS_MAX is too low"
                if api_url
                else "check your E2B plan's concurrency and the template"
            )
            raise _Fail(f"{type(exc).__name__}: {exc}", fix) from exc
        return handle.id

    if not await step("create sandbox", create):
        return report
    assert handle is not None
    h = handle

    try:

        async def workspace() -> str:
            checks = " && ".join(f"test -d {WORKSPACE}/{d} && test -w {WORKSPACE}/{d}" for d in WORKSPACE_DIRS)
            res = await provider.exec(h, f"{checks} && whoami")
            if res.exit_code != 0:
                raise _Fail(f"/workspace layout is missing or not writable: {res.render(400)}", "rebuild the template from infra/e2b/Dockerfile")
            return f"{', '.join(WORKSPACE_DIRS)} writable by {res.stdout.strip()}"

        async def toolchain() -> str:
            res = await provider.exec(h, "for t in bash python3 node git; do command -v $t >/dev/null || echo missing:$t; done; python3 --version")
            missing = [line.split(":", 1)[1] for line in res.stdout.splitlines() if line.startswith("missing:")]
            if missing:
                msg = f"missing {', '.join(missing)}"
                if strict_tools:
                    raise _Fail(msg, "rebuild runhive-base from infra/e2b/Dockerfile")
                raise _Warn(msg, "agents expect bash, python3, node and git; use the runhive-base template")
            return res.stdout.strip().splitlines()[-1]

        async def commands() -> str:
            res = await provider.exec(h, "echo out; echo err >&2; exit 3")
            if (res.exit_code, res.stdout.strip(), res.stderr.strip()) != (3, "out", "err"):
                raise _Fail(f"unexpected result {res!r}")
            slow = await provider.exec(h, "sleep 20", timeout=2)
            if not slow.timed_out:
                raise _Fail(f"a 2s timeout did not stop `sleep 20`: {slow!r}")
            return "exit codes, stderr and timeouts behave"

        payload = bytes(range(256)) * 64
        marker = f"/workspace/outputs/e2b-check-{uuid.uuid4().hex[:8]}.bin"

        async def files() -> str:
            await provider.write_files(h, [FileSpec(path=marker, content=payload)])
            back = (await provider.read_files(h, [marker]))[0].content
            if back != payload:
                raise _Fail(f"read back {len(back)} bytes that differ from the {len(payload)} written")
            return f"{len(payload)} bytes round-tripped"

        async def builtins() -> str:
            from ..tools.builtins import BUILTINS
            from ..tools.executor import CallContext, ToolExecutor
            from ..types import ToolCallBlock

            ex = ToolExecutor({n: BUILTINS[n] for n in ("shell", "files", "code")}, sandbox=provider, handle=h)
            ctx = CallContext(session_id="e2b-check", run_id="e2b-check", call_id="c", idempotency_key="e2b-check")

            async def call(name: str, args: dict[str, Any]) -> str:
                r = await ex.execute(ToolCallBlock(id="c", name=name, arguments=args), ctx)
                if r.is_error:
                    raise _Fail(f"{name} {args.get('command', '')}: {r.content[:300]}")
                return r.content

            path = "/workspace/e2b-check.md"
            await call("files", {"command": "create", "path": path, "file_text": "alpha\nbeta\n"})
            await call("files", {"command": "str_replace", "path": path, "old_str": "beta", "new_str": "gamma"})
            out = await call("shell", {"command": f"cat {path}"})
            if "gamma" not in out:
                raise _Fail(f"edit not visible to the shell: {out[:200]}")
            if strict_tools or "python3" not in (await provider.exec(h, "command -v python3")).stdout:
                code = await call("code", {"language": "python", "code": "print(6 * 7)"})
                if not code.startswith("42"):
                    raise _Fail(f"code tool printed {code[:100]!r}")
            return "shell, files and code tools work in the sandbox"

        async def pause_resume() -> str:
            nonlocal h
            await provider.pause(h)
            h = await provider.resume(h)
            back = (await provider.read_files(h, [marker]))[0].content
            if back != payload:
                raise _Fail("the file written before the pause changed after resume")
            return "paused and resumed with /workspace intact"

        for name, fn in (
            ("workspace layout", workspace),
            ("toolchain", toolchain),
            ("commands", commands),
            ("files", files),
            ("built-in tools", builtins),
        ):
            await step(name, fn)
        if pause:
            await step("pause and resume", pause_resume)
        else:
            report.steps.append(Step("pause and resume", "skip", "--no-pause"))
    finally:
        async def destroy() -> str:
            await provider.destroy(h)
            return h.id

        await step("destroy sandbox", destroy)

    if egress:
        await step("egress allowlist", lambda: _egress(provider, template, timeout_s))
    return report


async def _egress(provider: Any, template: str, timeout_s: int) -> str:
    env = Environment(name="e2b-check-egress", provider="e2b", template=template, timeout_s=timeout_s, allowed_hosts=["example.com"])
    h = await provider.create(env)
    try:
        probe = (
            "python3 - <<'EOF'\nimport urllib.request\nfor u in ('http://example.com', 'http://neverssl.com'):\n"
            "    try:\n        urllib.request.urlopen(u, timeout=8); print(u, 'open')\n"
            "    except Exception as e:\n        print(u, 'blocked', type(e).__name__)\nEOF"
        )
        res = await provider.exec(h, probe, timeout=40)
        lines = dict(line.split(" ", 1) for line in res.stdout.splitlines() if " " in line)
        if not lines.get("http://example.com", "").startswith("open"):
            raise _Fail(f"the allowed host was not reachable: {res.render(300)}", "check the install's outbound network and DNS")
        if not lines.get("http://neverssl.com", "").startswith("blocked"):
            raise _Fail("a host outside the allowlist was reachable", "the runtime is not enforcing allowOut/denyOut")
        return "allowed host reachable, others blocked"
    finally:
        await provider.destroy(h)
