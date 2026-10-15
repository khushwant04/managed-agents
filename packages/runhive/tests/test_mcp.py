from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from runhive import Agent
from runhive.runtime.local import LocalRuntime
from runhive.testing import ScriptedAdapter, calls, scripted_registry, text
from runhive.tools.executor import ToolExecutionError
from runhive.tools.mcp import McpClient, McpError, mcp_tool_specs
from runhive.tools.webhook import verify
from runhive.types import ToolSpec

URL = "https://obs.example.com/mcp"

TOOLS = [
    {"name": "search", "description": "Search logs.", "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}},
    {"name": "fail", "title": "Always fails", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "media", "description": "Returns mixed content.", "inputSchema": {"type": "object"}},
    {"name": "boom", "description": "Protocol error."},
]


class FakeMcpServer:
    """A Streamable HTTP MCP server for ``httpx.MockTransport``."""

    def __init__(self, mode: str = "json", page_size: int = 2) -> None:
        self.mode = mode
        self.page_size = page_size
        self.sessions = 0
        self.session_id: str | None = None
        self.requests: list[httpx.Request] = []
        self.messages: list[dict[str, Any]] = []
        self.deleted: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "DELETE":
            self.deleted.append(request.headers.get("mcp-session-id", ""))
            self.session_id = None
            return httpx.Response(200)
        assert "application/json" in request.headers["accept"] and "text/event-stream" in request.headers["accept"]
        msg = json.loads(request.content)
        self.messages.append(msg)
        if msg.get("method") == "initialize":
            self.sessions += 1
            self.session_id = f"sess-{self.sessions}"
            result = {
                "protocolVersion": msg["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "obs", "version": "1"},
            }
            return self._reply(msg["id"], {"result": result}, headers={"Mcp-Session-Id": self.session_id})
        sid = request.headers.get("mcp-session-id")
        if sid is None:
            return httpx.Response(400)
        if sid != self.session_id:
            return httpx.Response(404)
        if "method" not in msg:  # the client's reply to a server request (may arrive mid-initialize)
            return httpx.Response(202)
        assert request.headers["mcp-protocol-version"] == "2025-06-18"
        if "id" not in msg:  # notification
            return httpx.Response(202)
        if msg["method"] == "tools/list":
            start = int(msg["params"].get("cursor") or 0)
            page = TOOLS[start : start + self.page_size]
            result: dict[str, Any] = {"tools": page}
            if start + self.page_size < len(TOOLS):
                result["nextCursor"] = str(start + self.page_size)
            return self._reply(msg["id"], {"result": result})
        if msg["method"] == "tools/call":
            name, args = msg["params"]["name"], msg["params"]["arguments"]
            if name == "search":
                return self._reply(msg["id"], {"result": {"content": [{"type": "text", "text": f"found {args['q']}"}]}})
            if name == "fail":
                content = [{"type": "text", "text": "upstream down"}]
                return self._reply(msg["id"], {"result": {"content": content, "isError": True}})
            if name == "media":
                content = [
                    {"type": "text", "text": "chart:"},
                    {"type": "image", "data": "aGVsbG8=", "mimeType": "image/png"},
                    {"type": "resource_link", "uri": "file:///r.txt", "name": "r.txt"},
                    {"type": "resource", "resource": {"uri": "file:///e.txt", "text": "embedded"}},
                ]
                return self._reply(msg["id"], {"result": {"content": content}})
        return self._reply(msg["id"], {"error": {"code": -32602, "message": "Unknown tool: boom"}})

    def _reply(self, rid: int, body: dict[str, Any], headers: dict[str, str] | None = None) -> httpx.Response:
        payload = {"jsonrpc": "2.0", "id": rid, **body}
        if self.mode == "json":
            return httpx.Response(200, json=payload, headers=headers)
        # SSE: a comment, a server ping, then the response split over several data lines.
        ping = json.dumps({"jsonrpc": "2.0", "id": "srv-1", "method": "ping"})
        data = "".join(f"data: {line}\n" for line in json.dumps(payload, indent=1).splitlines())
        stream = f": keepalive\n\nid: 1\ndata: {ping}\n\nevent: message\nid: 2\n{data}\n"
        return httpx.Response(
            200, content=stream.encode(), headers={**(headers or {}), "Content-Type": "text/event-stream"}
        )


def client_for(server: FakeMcpServer, **kw: Any) -> McpClient:
    http = httpx.AsyncClient(transport=httpx.MockTransport(server.handler))
    return McpClient(URL, client=http, **kw)


@pytest.mark.parametrize("mode", ["json", "sse"])
async def test_handshake_list_and_call(mode):
    server = FakeMcpServer(mode)
    client = client_for(server, headers={"Authorization": "Bearer tok"})
    await client.connect()
    assert client.session_id == "sess-1" and client.protocol_version == "2025-06-18"
    init, initialized = [m for m in server.messages if "method" in m][:2]
    assert init["method"] == "initialize"
    assert init["params"]["capabilities"] == {} and init["params"]["clientInfo"]["name"] == "runhive"
    assert initialized == {"jsonrpc": "2.0", "method": "notifications/initialized"}
    assert "mcp-session-id" not in server.requests[0].headers
    assert server.requests[-1].headers["mcp-session-id"] == "sess-1"

    tools = await client.list_tools()
    assert [t.name for t in tools] == ["search", "fail", "media", "boom"]  # two pages
    assert [m["params"] for m in server.messages if m.get("method") == "tools/list"] == [{}, {"cursor": "2"}]
    assert tools[1].description == "Always fails"
    assert tools[3].input_schema == {"type": "object", "properties": {}}

    assert await client.call_tool("search", {"q": "oom"}) == "found oom"
    media = await client.call_tool("media", {})
    assert media.splitlines()[:3] == ["chart:", "[image: image/png, ~6 bytes]", "[resource link: r.txt file:///r.txt]"]
    assert "embedded" in media
    with pytest.raises(ToolExecutionError, match="upstream down"):
        await client.call_tool("fail", {})
    with pytest.raises(ToolExecutionError, match="Unknown tool: boom"):
        await client.call_tool("boom", {})
    assert all(r.headers.get("authorization") == "Bearer tok" for r in server.requests)
    if mode == "sse":
        # Server pings on the response stream are answered.
        assert {"jsonrpc": "2.0", "id": "srv-1", "result": {}} in server.messages

    await client.aclose()
    assert server.deleted == ["sess-1"]


async def test_jsonrpc_error_on_list_raises_mcp_error():
    def handler(request: httpx.Request) -> httpx.Response:
        msg = json.loads(request.content)
        if msg.get("method") == "initialize":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": msg["id"], "result": {"protocolVersion": "2025-06-18"}})
        if "id" not in msg:
            return httpx.Response(202)
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "Method not found"}})

    client = McpClient(URL, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    await client.connect()
    assert client.session_id is None  # stateless server: no session header sent back
    with pytest.raises(McpError, match="Method not found") as info:
        await client.list_tools()
    assert info.value.code == -32601


async def test_unsupported_version_and_http_errors():
    def old(request: httpx.Request) -> httpx.Response:
        msg = json.loads(request.content)
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": msg["id"], "result": {"protocolVersion": "1999-01-01"}})

    with pytest.raises(McpError, match="unsupported protocol version"):
        await McpClient(URL, client=httpx.AsyncClient(transport=httpx.MockTransport(old))).connect()

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    with pytest.raises(McpError, match="refused"):
        await McpClient(URL, client=httpx.AsyncClient(transport=httpx.MockTransport(down))).connect()


async def test_expired_session_reinitializes():
    server = FakeMcpServer()
    client = client_for(server)
    await client.connect()
    server.session_id = "sess-other"  # the server forgot our session: 404
    server.sessions = 1
    assert await client.call_tool("search", {"q": "x"}) == "found x"
    assert client.session_id == "sess-2"
    assert [m.get("method") for m in server.messages].count("initialize") == 2


def test_mcp_tool_specs_prefix_and_sanitize():
    tools = [ToolSpec(name="search"), ToolSpec(name="get.thing"), ToolSpec(name="get_thing"), ToolSpec(name="x" * 80)]
    specs = mcp_tool_specs("obs", tools)
    assert [s.name for s in specs[:3]] == ["obs__search", "obs__get_thing", "obs__get_thing_2"]
    assert len(specs[3].name) == 64
    assert [s.options["mcp_tool"] for s in specs] == ["search", "get.thing", "get_thing", "x" * 80]
    assert specs[0].options["mcp_server"] == "obs" and specs[0].kind == "function"


# -- end to end through LocalRuntime ------------------------------------------


async def test_local_runtime_mcp_and_webhook_tools():
    mcp = FakeMcpServer("sse")
    hooks: list[httpx.Request] = []

    def route(request: httpx.Request) -> httpx.Response:
        if request.url.host == "obs.example.com":
            return mcp.handler(request)
        hooks.append(request)
        assert verify("whsec", request.headers["x-runhive-signature"], request.content)
        body = json.loads(request.content)
        return httpx.Response(200, json={"result": {"deploys": [body["arguments"]["service"] + "-v42"]}})

    adapter = ScriptedAdapter(
        [
            calls([("obs__search", {"q": "5xx"}), ("lookup_deploys", {"service": "api"})], ids=["c1", "c2"]),
            text("done"),
        ]
    )
    agent = Agent(
        "investigator",
        "scripted",
        tools=[
            {"mcp": URL, "secret": "OBS_TOKEN"},
            {
                "type": "function",
                "name": "lookup_deploys",
                "url": "https://internal.example.com/tools/deploys",
                "input_schema": {"type": "object", "properties": {"service": {"type": "string"}}},
                "secrets": ["DEPLOY_KEY"],
            },
        ],
    )
    http = httpx.AsyncClient(transport=httpx.MockTransport(route))
    runtime = LocalRuntime(
        adapters=scripted_registry(adapter),
        secrets={"OBS_TOKEN": "obs-tok", "DEPLOY_KEY": "dk"},
        webhook_secret="whsec",
        http_client=http,
    )
    sid = await runtime.create_session(agent.spec(), functions=agent.functions)
    run_id = await runtime.send(sid, "investigate")
    result = await runtime.wait(sid)
    assert result.output == "done"

    names = [t.name for t in adapter.requests[0].tools]
    assert names == ["lookup_deploys", "obs__boom", "obs__fail", "obs__media", "obs__search"]
    results = adapter.requests[1].messages[-1].content
    assert results[0].content == "found 5xx" and not results[0].is_error
    assert json.loads(results[1].content) == {"deploys": ["api-v42"]}

    assert all(r.headers["authorization"] == "Bearer obs-tok" for r in mcp.requests)
    call = next(m for m in mcp.messages if m.get("method") == "tools/call")
    assert call["params"] == {"name": "search", "arguments": {"q": "5xx"}}

    (hook,) = hooks
    assert hook.headers["authorization"] == "Bearer dk"
    assert hook.headers["idempotency-key"].startswith(f"{run_id}:")
    body = json.loads(hook.content)
    assert body == {"tool": "lookup_deploys", "arguments": {"service": "api"}, "call_id": "c2", "session_id": sid, "run_id": run_id}

    await runtime.close(sid)
    assert mcp.deleted == ["sess-1"]


async def test_local_runtime_secrets_from_env_and_missing(monkeypatch):
    mcp = FakeMcpServer()
    http = httpx.AsyncClient(transport=httpx.MockTransport(mcp.handler))
    agent = Agent("a", "scripted", tools=[{"mcp": URL, "secret": "OBS_TOKEN"}])

    monkeypatch.delenv("OBS_TOKEN", raising=False)
    runtime = LocalRuntime(adapters=scripted_registry(ScriptedAdapter([])), http_client=http)
    with pytest.raises(ValueError, match="OBS_TOKEN"):
        await runtime.create_session(agent.spec())
    assert mcp.requests == [] and runtime.sessions == {}

    monkeypatch.setenv("OBS_TOKEN", "from-env")
    sid = await runtime.create_session(agent.spec())
    assert mcp.requests[0].headers["authorization"] == "Bearer from-env"
    await runtime.close(sid)
