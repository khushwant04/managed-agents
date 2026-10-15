"""``runhive``: the command line for Runhive.

    runhive run agent.yaml "5xx spike on service-api"          # local, embedded runtime
    runhive dev                                                # gateway + worker + scheduler locally
    runhive apply agent.yaml --promote prod                    # register a version (and move an alias)
    runhive deploy incident-investigator --alias prod --http --cron "*/30 * * * *" --input "Check error budgets"
    runhive promote incident-investigator 15 --canary 10       # 10% of new sessions to v15
    runhive rollback incident-investigator
    runhive invoke incident-investigator@prod "Why did p99 latency jump?"
    runhive sessions tail <session-id>
    runhive e2b check                                          # verify the E2B setup end to end

The server and key come from ``--url``/``RUNHIVE_BASE_URL`` and ``RUNHIVE_API_KEY``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from runhive import Agent
from runhive.client import APIError, AsyncClient
from runhive.events import Event

DIM, BOLD, CYAN, YELLOW, RED, RESET = "\033[2m", "\033[1m", "\033[36m", "\033[33m", "\033[31m", "\033[0m"


def _color(enabled: bool) -> None:
    global DIM, BOLD, CYAN, YELLOW, RED, RESET
    if not enabled:
        DIM = BOLD = CYAN = YELLOW = RED = RESET = ""


def load_agent(ref: str) -> Agent:
    """``agent.yaml``, ``path/to/file.py:variable`` or ``package.module:variable``."""
    if ref.endswith((".yaml", ".yml")):
        return Agent.from_yaml(ref)
    module_ref, _, attr = ref.partition(":")
    if module_ref.endswith(".py"):
        import importlib.util

        spec = importlib.util.spec_from_file_location("agent_module", module_ref)
        if spec is None or spec.loader is None:
            raise SystemExit(f"cannot load {module_ref}")
        module = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(Path(module_ref).resolve().parent))
        spec.loader.exec_module(module)
    else:
        import importlib

        module = importlib.import_module(module_ref)
    if attr:
        agent = getattr(module, attr)
    else:
        found = [v for v in vars(module).values() if isinstance(v, Agent)]
        if len(found) != 1:
            raise SystemExit(f"{module_ref} defines {len(found)} agents; name one with {module_ref}:<variable>")
        agent = found[0]
    if not isinstance(agent, Agent):
        raise SystemExit(f"{ref} is not an Agent")
    return agent


def render(ev: Event, *, verbose: bool = False) -> str | None:
    p = ev.payload
    if ev.type == "message.agent.delta":
        return ev.text
    if ev.type == "thinking.delta":
        return f"{DIM}{ev.text}{RESET}" if verbose else None
    if ev.type == "tool.call":
        args = json.dumps(p.get("arguments"), ensure_ascii=False)
        return f"\n{CYAN}→ {p.get('name')}{RESET} {DIM}{args[:300]}{RESET}\n"
    if ev.type == "tool.result":
        content = str(p.get("content", ""))
        head = content if verbose else content[:400] + ("…" if len(content) > 400 else "")
        color = RED if p.get("is_error") else DIM
        return f"{color}{head}{RESET}\n"
    if ev.type == "tool.approval.requested":
        return f"\n{YELLOW}⏸ approval needed for {p.get('name')} (call {p.get('call_id')}): {json.dumps(p.get('arguments'))}{RESET}\n"
    if ev.type == "route.resolved":
        return f"{DIM}{p.get('agent')}@{p.get('alias') or p.get('version')} → v{p.get('version')} on {p.get('model')}{RESET}\n"
    if ev.type == "run.finished":
        usage = p.get("usage") or {}
        tokens = f"{usage.get('input_tokens', 0)} in / {usage.get('output_tokens', 0)} out"
        err = f" — {p['error']}" if p.get("error") else ""
        return f"\n{DIM}[{p.get('stop_reason')}] {tokens}{err}{RESET}\n"
    if ev.type == "artifact.created":
        return f"{DIM}artifact: {p.get('path')} ({p.get('size')} bytes){RESET}\n"
    if ev.type in ("subagent.started", "subagent.finished"):
        return f"{DIM}{ev.type} {p.get('agent', '')} {p.get('child_session_id', '')}{RESET}\n"
    if ev.type == "error":
        return f"{RED}{p.get('kind', 'error')}: {p.get('message')}{RESET}\n"
    if ev.type == "session.status" and verbose:
        return f"{DIM}status: {p.get('status')}{RESET}\n"
    return None


def emit(ev: Event, args: argparse.Namespace) -> None:
    if getattr(args, "json", False):
        print(ev.model_dump_json(), flush=True)
        return
    out = render(ev, verbose=getattr(args, "verbose", False))
    if out:
        sys.stdout.write(out)
        sys.stdout.flush()


def client(args: argparse.Namespace) -> AsyncClient:
    return AsyncClient(args.url, args.key)


def print_json(data: Any) -> None:
    print(json.dumps(data, indent=2, default=str))


# -- commands ------------------------------------------------------------------


async def cmd_run(args: argparse.Namespace) -> int:
    from runhive.sandbox import Sandbox

    agent = load_agent(args.agent)
    sandbox = {"local": Sandbox.local, "docker": Sandbox.docker, "e2b": Sandbox.e2b}[args.sandbox]()
    session = await agent.astart(args.input, sandbox=sandbox)
    try:
        while True:
            async for ev in session.events():
                emit(ev, args)
            if session.status == "approval_pending" and sys.stdin.isatty() and session.result:
                for req in session.result.pending_approvals:
                    prompt = f"Approve {req['name']} {json.dumps(req['arguments'])}? [y/N] "
                    answer = (await asyncio.to_thread(input, prompt)).strip().lower()
                    await session.approve(req["call_id"], answer in ("y", "yes"))
                continue
            break
        for f in await session.artifacts():
            target = Path(args.outputs) / f.path.removeprefix("/workspace/outputs/")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(f.content)
            print(f"{DIM}saved {target}{RESET}")
        return 0 if session.status != "failed" else 1
    finally:
        await session.close()


def cmd_dev(args: argparse.Namespace) -> int:
    env = os.environ
    env.setdefault("RUNHIVE_SANDBOX_PROVIDER", args.sandbox)
    env.setdefault("RUNHIVE_BOOTSTRAP_KEY", "ak_dev_admin")
    env.setdefault("RUNHIVE_BLOB_URL", f"file://{Path('.agents/blobs').resolve()}")
    if args.database_url:
        env["DATABASE_URL"] = args.database_url
    if "RUNHIVE_MASTER_KEY" not in env:
        import base64

        key_file = Path(".agents/master.key")
        if not key_file.exists():
            key_file.parent.mkdir(parents=True, exist_ok=True)
            key_file.write_text(base64.b64encode(os.urandom(32)).decode())
            key_file.chmod(0o600)
        env["RUNHIVE_MASTER_KEY"] = key_file.read_text().strip()
    print(f"{BOLD}runhive dev{RESET}: http://localhost:{args.port}  key: {env['RUNHIVE_BOOTSTRAP_KEY']}  sandbox: {env['RUNHIVE_SANDBOX_PROVIDER']}")
    print(f"{DIM}database: {env.get('DATABASE_URL', 'postgresql://agents:agents@localhost:5432/agents')} (start one with: docker compose up -d postgres){RESET}")
    from runhive_server.__main__ import main as server_main

    server_main(["all", "--port", str(args.port)])
    return 0


async def cmd_apply(args: argparse.Namespace) -> int:
    agent = load_agent(args.agent)
    async with client(args) as c:
        v = await c.agents.register(agent)
        print(f"{agent.name}: version {v.version} ({'new' if v.created else 'unchanged'}, {v.hash[:12]})")
        if args.promote:
            await c.agents.promote(agent.name, v.version, alias=args.promote)
            print(f"{agent.name}@{args.promote} → v{v.version}")
    return 0


async def cmd_deploy(args: argparse.Namespace) -> int:
    triggers: list[dict[str, Any]] = []
    if args.http or not (args.cron or args.webhook or args.queue):
        triggers.append({"type": "http"})
    for schedule in args.cron or []:
        if not args.input:
            raise SystemExit("--cron needs --input")
        triggers.append({"type": "cron", "schedule": schedule, "input": args.input, "timezone": args.timezone})
    for provider in args.webhook or []:
        trigger: dict[str, Any] = {"type": "webhook", "provider": provider}
        if args.input:
            trigger["input"] = args.input
        triggers.append(trigger)
    for name in args.queue or []:
        triggers.append({"type": "queue", "name": name})
    async with client(args) as c:
        dep = await c.deployments.create(
            args.agent,
            alias=args.alias,
            version=args.version,
            triggers=triggers,
            name=args.name,
            concurrency=args.concurrency,
            environment=args.environment,
            secrets=args.secret,
        )
    if args.json:
        print_json(dep)
        return 0
    print(f"deployed {dep['name']} ({dep['agent']}@{dep['alias']}) id={dep['id']}")
    if dep.get("webhook_url"):
        print(f"webhook url:    {dep['webhook_url']}\nwebhook secret: {dep['webhook_secret']}  (shown once)")
    return 0


async def cmd_promote(args: argparse.Namespace) -> int:
    async with client(args) as c:
        if args.canary is not None:
            res = await c.agents.canary(args.agent, args.version, args.canary, alias=args.alias)
        else:
            res = await c.agents.promote(args.agent, args.version, alias=args.alias)
    print(f"{args.agent}@{args.alias} → " + ", ".join(f"v{v['version']} {v['weight']}%" for v in res["versions"]))
    return 0


async def cmd_rollback(args: argparse.Namespace) -> int:
    async with client(args) as c:
        res = await c.agents.rollback(args.agent, args.alias)
    print(f"{args.agent}@{args.alias} → " + ", ".join(f"v{v['version']} {v['weight']}%" for v in res["versions"]))
    return 0


async def cmd_invoke(args: argparse.Namespace) -> int:
    async with client(args) as c:
        session = await c.invoke(args.target, args.input)
        if args.no_wait:
            print_json({"session_id": session.id, "run_id": session.run_id})
            return 0
        async for ev in session.events():
            emit(ev, args)
        info = await c.sessions.get(session.id)
    return 0 if info["status"] != "failed" else 1


async def cmd_sessions(args: argparse.Namespace) -> int:
    async with client(args) as c:
        if args.action == "list":
            rows = await c.sessions.list(agent=args.agent, limit=args.limit)
            if args.json:
                print_json(rows)
            for r in rows if not args.json else []:
                print(f"{r['id']}  {r['agent']}@{r['alias'] or r['version']}  v{r['version']}  {r['status']:<16} {r['created_at']}")
        elif args.action == "tail":
            async for ev in c.stream_events(args.session, after=args.after, until_settled=not args.follow):
                emit(ev, args)
        elif args.action == "send":
            print_json(await c.sessions.send(args.session, args.text))
        elif args.action in ("approve", "deny"):
            print_json(await c.sessions.approve(args.session, args.call_id, args.action == "approve", args.reason))
        elif args.action == "interrupt":
            print_json(await c.sessions.interrupt(args.session))
        elif args.action == "show":
            print_json(await c.sessions.get(args.session))
        elif args.action == "artifacts":
            arts = await c.sessions.artifacts(args.session)
            for a in arts:
                if args.download:
                    target = Path(args.download) / a["path"]
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(await c.sessions.download(args.session, a["id"]))
                    print(f"saved {target}")
                else:
                    print(f"{a['id']}  {a['path']}  {a['size_bytes']} bytes")
    return 0


async def cmd_deployments(args: argparse.Namespace) -> int:
    async with client(args) as c:
        if args.action == "list":
            rows = await c.deployments.list()
            if args.json:
                print_json(rows)
            for d in rows if not args.json else []:
                kinds = ",".join(t["type"] for t in d["triggers"])
                print(f"{d['name']:<32} {d['agent']}@{d['alias']:<10} {d['status']:<8} {kinds}")
        elif args.action == "pause":
            print_json(await c.deployments.pause(args.name))
        elif args.action == "resume":
            print_json(await c.deployments.resume(args.name))
        elif args.action == "delete":
            await c.deployments.delete(args.name)
            print(f"deleted {args.name}")
    return 0


async def cmd_secrets(args: argparse.Namespace) -> int:
    async with client(args) as c:
        if args.action == "set":
            value = args.value if args.value is not None else sys.stdin.read().rstrip("\n")
            res = await c.secrets.set(args.name, value)
            print(f"{res['name']} v{res['version']}")
        elif args.action == "list":
            for s in await c.secrets.list():
                print(f"{s['name']:<32} v{s['version']}")
        elif args.action == "delete":
            await c.secrets.delete(args.name)
            print(f"deleted {args.name}")
    return 0


async def cmd_e2b_check(args: argparse.Namespace) -> int:
    from dataclasses import asdict

    from runhive.sandbox.e2b_check import check_e2b

    report = await check_e2b(
        template=args.template,
        api_url=args.api_url,
        sandbox_url=args.sandbox_url,
        egress=args.egress,
        pause=not args.no_pause,
    )
    if args.json:
        print_json({"ok": report.ok, "api_url": report.api_url, "template": report.template, "steps": [asdict(s) for s in report.steps]})
    else:
        print(report.render())
    return 0 if report.ok else 1


async def cmd_versions(args: argparse.Namespace) -> int:
    async with client(args) as c:
        versions = await c.agents.versions(args.agent)
        aliases = await c.agents.aliases(args.agent)
    if args.json:
        print_json({"versions": versions, "aliases": aliases})
        return 0
    for a in aliases:
        print(f"@{a['alias']:<10} " + ", ".join(f"v{v['version']} {v['weight']}%" for v in a["versions"]))
    for v in versions:
        print(f"v{v['version']:<4} {v['hash'][:12]}  {v['created_at']}  {v.get('created_by') or ''}")
    return 0


# -- parser -------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="runhive", description="Define, run and deploy agents.")
    p.add_argument("--url", default=None, help="server URL (default $RUNHIVE_BASE_URL or http://localhost:8080)")
    p.add_argument("--key", default=None, help="API key (default $RUNHIVE_API_KEY)")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--no-color", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="run an agent locally with the embedded runtime")
    r.add_argument("agent", help="agent.yaml, file.py[:var] or module:var")
    r.add_argument("input")
    r.add_argument("--sandbox", choices=["local", "docker", "e2b"], default="local")
    r.add_argument("--outputs", default="outputs", help="where to save /workspace/outputs")
    r.set_defaults(fn=cmd_run)

    d = sub.add_parser("dev", help="run gateway, worker and scheduler locally")
    d.add_argument("--port", type=int, default=8080)
    d.add_argument("--sandbox", choices=["docker", "local", "e2b"], default="docker")
    d.add_argument("--database-url")
    d.set_defaults(fn=cmd_dev, sync=True)

    a = sub.add_parser("apply", help="register an agent version")
    a.add_argument("agent")
    a.add_argument("--promote", metavar="ALIAS", help="point this alias at the new version")
    a.set_defaults(fn=cmd_apply)

    dp = sub.add_parser("deploy", help="expose an alias through triggers")
    dp.add_argument("agent")
    dp.add_argument("--alias", default="prod")
    dp.add_argument("--version", type=int)
    dp.add_argument("--name")
    dp.add_argument("--http", action="store_true")
    dp.add_argument("--cron", action="append", metavar="SCHEDULE")
    dp.add_argument("--timezone", default="UTC")
    dp.add_argument("--webhook", action="append", choices=["github", "slack", "stripe", "generic"])
    dp.add_argument("--queue", action="append")
    dp.add_argument("--input", help="input for cron triggers, or a webhook input template")
    dp.add_argument("--concurrency", type=int, default=10)
    dp.add_argument("--environment")
    dp.add_argument("--secret", action="append", default=[])
    dp.set_defaults(fn=cmd_deploy)

    pr = sub.add_parser("promote", help="move an alias to a version")
    pr.add_argument("agent")
    pr.add_argument("version", type=int)
    pr.add_argument("--alias", default="prod")
    pr.add_argument("--canary", type=int, metavar="PERCENT", help="send only this share of new sessions to the version")
    pr.set_defaults(fn=cmd_promote)

    rb = sub.add_parser("rollback", help="move an alias back to its previous target")
    rb.add_argument("agent")
    rb.add_argument("--alias", default="prod")
    rb.set_defaults(fn=cmd_rollback)

    iv = sub.add_parser("invoke", help="start a session through the router and stream it")
    iv.add_argument("target", help="name@alias, name@version or name")
    iv.add_argument("input")
    iv.add_argument("--no-wait", action="store_true")
    iv.set_defaults(fn=cmd_invoke)

    vs = sub.add_parser("versions", help="list an agent's versions and aliases")
    vs.add_argument("agent")
    vs.set_defaults(fn=cmd_versions)

    s = sub.add_parser("sessions", help="inspect and steer sessions")
    ss = s.add_subparsers(dest="action", required=True)
    sl = ss.add_parser("list")
    sl.add_argument("--agent")
    sl.add_argument("--limit", type=int, default=20)
    st = ss.add_parser("tail")
    st.add_argument("session")
    st.add_argument("--after", type=int, default=0)
    st.add_argument("-f", "--follow", action="store_true", help="keep following after the run settles")
    ss.add_parser("show").add_argument("session")
    sd = ss.add_parser("send")
    sd.add_argument("session")
    sd.add_argument("text")
    for verb in ("approve", "deny"):
        sa = ss.add_parser(verb)
        sa.add_argument("session")
        sa.add_argument("call_id")
        sa.add_argument("--reason")
    ss.add_parser("interrupt").add_argument("session")
    sa = ss.add_parser("artifacts")
    sa.add_argument("session")
    sa.add_argument("--download", metavar="DIR")
    s.set_defaults(fn=cmd_sessions)

    de = sub.add_parser("deployments", help="list, pause, resume or delete deployments")
    des = de.add_subparsers(dest="action", required=True)
    des.add_parser("list")
    for verb in ("pause", "resume", "delete"):
        des.add_parser(verb).add_argument("name")
    de.set_defaults(fn=cmd_deployments)

    e2b = sub.add_parser("e2b", help="E2B sandbox tooling")
    e2bs = e2b.add_subparsers(dest="action", required=True)
    chk = e2bs.add_parser(
        "check",
        help="check an E2B setup end to end (E2B Cloud, or a self-hosted runtime such as E2B Embed)",
        description="Uses E2B_API_KEY, and E2B_API_URL / E2B_SANDBOX_URL for a self-hosted runtime.",
    )
    chk.add_argument("--template", default="runhive-base")
    chk.add_argument("--api-url", help="self-hosted API, e.g. http://host:3000 (default $E2B_API_URL)")
    chk.add_argument("--sandbox-url", help="self-hosted sandbox proxy, e.g. http://host:3002 (default $E2B_SANDBOX_URL)")
    chk.add_argument("--egress", action="store_true", help="also check the egress allowlist")
    chk.add_argument("--no-pause", action="store_true", help="skip the pause and resume check")
    e2b.set_defaults(fn=cmd_e2b_check)

    se = sub.add_parser("secrets", help="manage encrypted secrets")
    ses = se.add_subparsers(dest="action", required=True)
    sset = ses.add_parser("set")
    sset.add_argument("name")
    sset.add_argument("--value", help="value (default: read from stdin)")
    ses.add_parser("list")
    ses.add_parser("delete").add_argument("name")
    se.set_defaults(fn=cmd_secrets)
    return p


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    _color(sys.stdout.isatty() and not args.no_color and not os.environ.get("NO_COLOR"))
    try:
        if getattr(args, "sync", False):
            code = args.fn(args)
        else:
            code = asyncio.run(args.fn(args))
    except APIError as exc:
        print(f"{RED}error: {exc}{RESET}", file=sys.stderr)
        code = 1
    except KeyboardInterrupt:
        code = 130
    sys.exit(code)


if __name__ == "__main__":
    main()
