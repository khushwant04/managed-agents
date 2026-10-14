"""The E2B setup check, against a fake E2B API and a local stand-in for the sandbox."""

from __future__ import annotations

import json
import os

import httpx
import pytest

import agents.sandbox.e2b as e2b_module
from agents.sandbox.e2b_check import check_e2b
from agents.sandbox.local import LocalSandboxProvider

TEMPLATES = [
    {"templateID": "tpl_base", "aliases": ["base"], "names": ["base"], "buildStatus": "ready"},
    {"templateID": "tpl_agents", "aliases": ["agents-base"], "names": ["agents-base"], "buildStatus": "ready"},
]


def fake_api(templates=TEMPLATES, *, status=200, v2=True, pages=1):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.headers.get("X-API-Key") != "e2b_key":
            return httpx.Response(401, json={"message": "invalid key"})
        if status != 200:
            return httpx.Response(status, text="boom")
        if request.url.path == "/v2/templates" and v2:
            page = 0 if "nextToken" not in request.url.params else int(request.url.params["nextToken"])
            chunk = templates[page::pages] if pages > 1 else templates
            headers = {"X-Next-Token": str(page + 1)} if page + 1 < pages else {}
            return httpx.Response(200, json=chunk, headers=headers)
        if request.url.path == "/templates":
            return httpx.Response(200, json=templates)
        return httpx.Response(404)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), seen


class LocalStandIn(LocalSandboxProvider):
    """Plays the E2B provider: same interface, a local directory instead of a microVM."""

    name = "e2b"
    created: list[dict] = []

    def __init__(self, **conn):
        super().__init__()
        LocalStandIn.created.append(conn)


@pytest.fixture
def standin(monkeypatch):
    LocalStandIn.created = []
    monkeypatch.setattr(e2b_module, "E2BSandboxProvider", LocalStandIn)
    for var in ("E2B_API_KEY", "E2B_API_URL", "E2B_SANDBOX_URL"):
        monkeypatch.delenv(var, raising=False)
    return LocalStandIn


async def test_full_pass_against_a_self_hosted_install(standin):
    http, seen = fake_api()
    report = await check_e2b(api_key="e2b_key", api_url="http://embed:3000/", sandbox_url="http://embed:3002", http=http)
    assert report.ok, report.render()
    names = [s.name for s in report.steps]
    assert names == [
        "configuration", "api reachable", "template ready", "create sandbox", "workspace layout", "toolchain",
        "commands", "files", "built-in tools", "pause and resume", "destroy sandbox",
    ]  # fmt: skip
    assert report.self_hosted and report.api_url == "http://embed:3000"
    assert str(seen[0].url) == "http://embed:3000/v2/templates?limit=100"
    assert standin.created[0] == {"api_key": "e2b_key", "api_url": "http://embed:3000", "sandbox_url": "http://embed:3002"}
    assert "PASS" in report.render()


async def test_missing_key_and_half_configured_self_hosting(standin):
    report = await check_e2b()
    assert not report.ok and report.steps[0].status == "fail" and "E2B_API_KEY" in report.steps[0].detail
    assert [s.status for s in report.steps[1:]] == ["skip", "skip", "skip"]
    report = await check_e2b(api_key="e2b_key", api_url="http://embed:3000")
    assert "E2B_SANDBOX_URL" in report.steps[0].detail and "3002" in report.steps[0].fix


async def test_bad_key_and_api_errors(standin):
    http, _ = fake_api()
    report = await check_e2b(api_key="wrong", api_url="http://embed:3000", sandbox_url="http://embed:3002", http=http)
    api = report.steps[1]
    assert api.status == "fail" and "401" in api.detail and "API key" in api.fix
    http, _ = fake_api(status=503)
    report = await check_e2b(api_key="e2b_key", http=http)
    assert report.steps[1].status == "fail" and "503" in report.steps[1].detail

    def down(request):
        raise httpx.ConnectError("refused")

    report = await check_e2b(
        api_key="e2b_key", api_url="http://nope:3000", sandbox_url="http://nope:3002",
        http=httpx.AsyncClient(transport=httpx.MockTransport(down)),
    )  # fmt: skip
    assert "cannot reach" in report.steps[1].detail and "E2B_API_URL" in report.steps[1].fix


async def test_template_missing_or_not_built(standin):
    http, _ = fake_api([TEMPLATES[0]])
    report = await check_e2b(api_key="e2b_key", http=http)
    tpl = report.steps[2]
    assert tpl.status == "fail" and "agents-base" in tpl.detail and "build_template.py" in tpl.fix
    building = [{**TEMPLATES[1], "buildStatus": "building"}]
    http, _ = fake_api(building)
    report = await check_e2b(api_key="e2b_key", http=http)
    assert "building" in report.steps[2].detail


async def test_paginated_listing_and_legacy_endpoint(standin):
    http, seen = fake_api(pages=2)
    report = await check_e2b(api_key="e2b_key", http=http, pause=False)
    assert report.steps[2].status == "ok"
    assert [r.url.params.get("nextToken") for r in seen] == [None, "1"]
    assert report.steps[-2].status == "skip"  # --no-pause
    http, seen = fake_api(v2=False)
    report = await check_e2b(api_key="e2b_key", http=http)
    assert report.ok and [r.url.path for r in seen] == ["/v2/templates", "/templates"]


async def test_stock_template_downgrades_tool_checks(standin, monkeypatch):
    real_exec = LocalSandboxProvider.exec

    async def no_node(self, h, cmd, timeout=None):
        return await real_exec(self, h, cmd.replace("python3 node git", "python3 nodejs-missing git"), timeout)

    monkeypatch.setattr(LocalStandIn, "exec", no_node)
    http, _ = fake_api()
    report = await check_e2b(api_key="e2b_key", template="base", http=http)
    tool = next(s for s in report.steps if s.name == "toolchain")
    assert tool.status == "warn" and "nodejs-missing" in tool.detail and report.ok
    http, _ = fake_api()
    report = await check_e2b(api_key="e2b_key", http=http)  # agents-base: required
    assert next(s for s in report.steps if s.name == "toolchain").status == "fail" and not report.ok


async def test_cli_json_output(standin, monkeypatch, capsys):
    from agents_cli.main import build_parser

    http, _ = fake_api()
    import agents.sandbox.e2b_check as chk

    real = chk.check_e2b
    monkeypatch.setattr(chk, "check_e2b", lambda **kw: real(api_key="e2b_key", http=http, **kw))
    args = build_parser().parse_args(["--json", "e2b", "check", "--no-pause"])
    assert await args.fn(args) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] and out["template"] == "agents-base" and len(out["steps"]) == 11


@pytest.mark.live
@pytest.mark.skipif(not os.environ.get("E2B_API_KEY"), reason="E2B_API_KEY not set")
async def test_live_e2b_setup():
    """Runs the real check: E2B Cloud, or a self-hosted runtime via E2B_API_URL / E2B_SANDBOX_URL."""
    pytest.importorskip("e2b")
    report = await check_e2b(template=os.environ.get("E2B_CHECK_TEMPLATE", "agents-base"), egress=bool(os.environ.get("E2B_CHECK_EGRESS")))
    print(report.render())
    assert report.ok, report.render()
