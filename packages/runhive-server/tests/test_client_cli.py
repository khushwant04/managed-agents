from __future__ import annotations

import asyncio
import contextlib
import socket
import textwrap

import pytest
import uvicorn
from test_api import ADMIN, env  # noqa: F401  (fixture)

from runhive import Agent, AsyncClient, Client, tool
from runhive.client import APIError
from runhive.testing import call, text
from runhive_cli.main import build_parser
from runhive_server.api import create_app


@contextlib.asynccontextmanager
async def serve(env):  # noqa: F811
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(env["services"]), host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await task


@tool(sandbox=True)
def word_count(text: str) -> dict:
    """Count words."""
    return {"words": len(text.split())}


@tool(url="https://tools.example.com/deploys")
def lookup_deploys(service: str) -> list:
    """List deploys."""
    return []


@tool
def local_only(x: int) -> int:
    """Only runs in-process."""
    return x


async def test_async_client_end_to_end(env, tmp_path):  # noqa: F811
    skill = tmp_path / "runbooks"
    skill.mkdir()
    (skill / "SKILL.md").write_text("---\nname: runbooks\ndescription: Ops runbooks\n---\nCheck dashboards.\n")
    agent = Agent("ops", "scripted", "Operate.", tools=["shell", word_count, lookup_deploys], skills=[skill])
    env["adapter"].turns += [
        call("word_count", {"text": "one two three"}, id="w"),
        call("shell", {"command": "cat /workspace/skills/runbooks/SKILL.md > /workspace/outputs/notes.md"}, id="s"),
        text("all done"),
    ]
    async with serve(env) as url, AsyncClient(url, ADMIN) as c:
        v = await c.agents.register(agent)
        assert v.version == 1 and v.created
        assert (await c.agents.register(agent)).created is False
        spec = (await c.agents.get("ops", 1))["spec"]
        assert spec["skills"][0]["name"] == "runbooks" and spec["skills"][0]["version"]
        wc = next(t for t in spec["tools"] if t["name"] == "word_count")
        assert "def word_count" in wc["options"]["script"] and "@tool" not in wc["options"]["script"]
        with pytest.raises(ValueError, match="only runs in-process"):
            await c.agents.register(Agent("bad", "scripted", tools=[local_only]))
        with pytest.raises(APIError) as info:
            await c.agents.register({"name": "x", "models": ["nope-model"]})
        assert info.value.status == 422 and info.value.problems

        await c.agents.promote("ops", 1)
        session = await c.invoke("ops@prod", "go")
        types = [ev.type async for ev in session.events()]
        assert types[0] == "route.resolved" and types[-1] == "session.status"
        info2 = await session.wait()
        assert info2["last_run"]["output"] == "all done" and session.output == "all done"
        result = env["adapter"].requests[1].messages[-1].content[0]
        assert result.content == '{"words": 3}'
        arts = await session.artifacts()
        assert arts[0]["path"] == "notes.md"
        assert b"Check dashboards." in await session.download(arts[0]["id"])

        await c.agents.register(Agent("ops", "scripted", "Operate v2.", tools=["shell", word_count, lookup_deploys], skills=[skill]))
        res = await c.agents.canary("ops", 2, 25)
        assert {v["version"]: v["weight"] for v in res["versions"]} == {1: 75, 2: 25}
        res = await c.agents.rollback("ops")
        assert res["versions"] == [{"version": 1, "weight": 100}]

        dep = await c.deployments.create("ops", triggers=[{"type": "http"}], name="ops-http")
        assert [d["name"] for d in await c.deployments.list()] == ["ops-http"]
        assert (await c.deployments.pause("ops-http"))["status"] == "paused"
        assert (await c.secrets.set("TOKEN", "v"))["version"] == 1
        assert [s["name"] for s in await c.secrets.list()] == ["TOKEN"]
        assert dep["agent"] == "ops"


async def test_sync_client_from_a_thread(env):  # noqa: F811
    env["adapter"].turns += [text("sync hello")]
    async with serve(env) as url:

        def work() -> tuple[int, list[str], str]:
            with Client(url, ADMIN) as c:
                v = c.agents.register(Agent("greeter", "scripted"))
                c.agents.promote("greeter", v.version)
                session = c.invoke("greeter@prod", "hi")
                types = [ev.type for ev in session.events()]
                info = c.sessions.get(session.id)
                return v.version, types, info["last_run"]["output"]

        version, types, output = await asyncio.to_thread(work)
    assert version == 1 and "message.agent.done" in types and output == "sync hello"


async def run_cli(argv: list[str], capsys) -> str:
    args = build_parser().parse_args(argv)
    code = await args.fn(args)
    assert code == 0
    return capsys.readouterr().out


async def test_cli_apply_deploy_invoke_and_sessions(env, tmp_path, capsys):  # noqa: F811
    (tmp_path / "agent.yaml").write_text(
        textwrap.dedent(
            """\
            name: triage
            model: scripted
            instructions: Triage alerts.
            tools: [shell]
            """
        )
    )
    env["adapter"].turns += [call("shell", {"command": "echo checked"}, id="c"), text("triaged")]
    async with serve(env) as url:
        base = ["--url", url, "--key", ADMIN, "--no-color"]
        out = await run_cli([*base, "apply", str(tmp_path / "agent.yaml"), "--promote", "prod"], capsys)
        assert "triage: version 1 (new" in out and "triage@prod → v1" in out
        out = await run_cli([*base, "deploy", "triage", "--http", "--cron", "0 9 * * *", "--input", "Morning triage", "--webhook", "github"], capsys)
        assert "deployed triage-prod" in out and "webhook secret:" in out
        out = await run_cli([*base, "invoke", "triage@prod", "disk alert"], capsys)
        assert "→ shell" in out and "checked" in out and "triaged" in out and "[end_turn]" in out
        out = await run_cli([*base, "versions", "triage"], capsys)
        assert "@prod       v1 100%" in out
        out = await run_cli([*base, "--json", "sessions", "list"], capsys)
        assert '"agent": "triage"' in out
        out = await run_cli([*base, "deployments", "list"], capsys)
        assert "triage-prod" in out and "http,cron,webhook" in out


async def test_cli_run_locally(tmp_path, capsys):
    from runhive.testing import ScriptedAdapter, scripted_registry

    adapter = ScriptedAdapter([call("shell", {"command": "echo report > /workspace/outputs/r.txt"}, id="c"), text("local done")])
    (tmp_path / "agent.yaml").write_text("name: local\nmodel: scripted\ntools: [shell]\n")
    import runhive.agent as agent_module

    original = agent_module.Agent.astart

    async def patched(self, input=None, *, sandbox=None, adapters=None):
        return await original(self, input, sandbox=sandbox, adapters=scripted_registry(adapter))

    agent_module.Agent.astart = patched
    try:
        out = await run_cli(["--no-color", "run", str(tmp_path / "agent.yaml"), "go", "--outputs", str(tmp_path / "out")], capsys)
    finally:
        agent_module.Agent.astart = original
    assert "local done" in out and (tmp_path / "out" / "r.txt").read_text() == "report\n"
