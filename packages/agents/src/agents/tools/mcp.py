"""A minimal MCP client over the Streamable HTTP transport (spec revision 2025-06-18).

The tool gateway acts as the MCP client (ADR-0009): it connects at session
start, lists the server's tools, presents them to the model as
``<server>__<tool>`` and calls them with ``tools/call``. Only what tool use
needs is implemented: initialization, ``tools/list`` with pagination,
``tools/call``, session ids and re-initialization when a session expires.
Server-initiated requests arriving on a response stream are answered (``ping``)
or declined; the optional GET stream is not opened.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import re
from typing import Any

import httpx

from ..types import ToolSpec
from .executor import ToolExecutionError

PROTOCOL_VERSION = "2025-06-18"
SUPPORTED_VERSIONS = frozenset({"2025-06-18", "2025-03-26"})
CLIENT_INFO = {"name": "managed-agents", "version": "0.1.0"}
MAX_PAGES = 100
_NAME_OK = re.compile(r"[^a-zA-Z0-9_-]")
MAX_TOOL_NAME = 64


class McpError(Exception):
    """A transport, protocol or JSON-RPC error talking to an MCP server."""

    def __init__(self, message: str, *, code: int | None = None, data: Any = None, status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.data = data
        self.status = status


class McpClient:
    """One MCP session with one server."""

    def __init__(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        timeout: float = 60,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.url = url
        self.headers = dict(headers or {})
        self.timeout = timeout
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self._owns_client = client is None
        self._ids = itertools.count(1)
        self._lock = asyncio.Lock()
        self.session_id: str | None = None
        self.protocol_version: str | None = None
        self.server_info: dict[str, Any] = {}
        self.server_capabilities: dict[str, Any] = {}
        self.instructions: str | None = None

    async def __aenter__(self) -> McpClient:
        await self.connect()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    # -- lifecycle --------------------------------------------------------

    async def connect(self) -> None:
        """Run the initialization handshake, starting a new MCP session."""
        async with self._lock:
            await self._initialize()

    async def _initialize(self) -> None:
        self.session_id = None
        self.protocol_version = None
        result = await self._send(
            "initialize",
            {"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": CLIENT_INFO},
        )
        version = result.get("protocolVersion")
        if version not in SUPPORTED_VERSIONS:
            raise McpError(f"MCP server at {self.url} offered unsupported protocol version {version!r}")
        self.protocol_version = version
        self.server_info = result.get("serverInfo") or {}
        self.server_capabilities = result.get("capabilities") or {}
        self.instructions = result.get("instructions")
        await self._notify("notifications/initialized")

    async def aclose(self) -> None:
        """End the MCP session (best effort) and release the HTTP client if we own it."""
        try:
            if self.session_id is not None:
                try:
                    await self._client.delete(self.url, headers=self._headers(), timeout=5)
                except httpx.HTTPError:
                    pass
                self.session_id = None
        finally:
            if self._owns_client:
                await self._client.aclose()

    # -- tools ------------------------------------------------------------

    async def list_tools(self) -> list[ToolSpec]:
        """All tools the server offers, with their original MCP names."""
        tools: list[ToolSpec] = []
        cursor: str | None = None
        for _ in range(MAX_PAGES):
            result = await self._request("tools/list", {"cursor": cursor} if cursor else {})
            for t in result.get("tools") or []:
                tools.append(
                    ToolSpec(
                        name=t["name"],
                        description=t.get("description") or t.get("title") or "",
                        input_schema=t.get("inputSchema") or {"type": "object", "properties": {}},
                    )
                )
            cursor = result.get("nextCursor")
            if not cursor:
                return tools
        raise McpError(f"MCP server at {self.url} returned more than {MAX_PAGES} pages of tools")

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        """Call a tool by its original MCP name and render the result as text."""
        try:
            result = await self._request("tools/call", {"name": name, "arguments": arguments})
        except McpError as exc:
            raise ToolExecutionError(f"MCP tool {name!r} failed: {exc}") from exc
        text = render_content(result)
        if result.get("isError"):
            raise ToolExecutionError(text or f"MCP tool {name!r} reported an error.")
        return text

    # -- JSON-RPC over Streamable HTTP -----------------------------------

    async def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if self.protocol_version is None:
            await self.connect()
        session = self.session_id
        try:
            return await self._send(method, params)
        except McpError as exc:
            # The server ended our session: start a new one and retry once (spec: MUST re-initialize).
            if exc.status != 404 or session is None:
                raise
        async with self._lock:
            if self.session_id == session:
                await self._initialize()
        return await self._send(method, params)

    def _headers(self) -> dict[str, str]:
        headers = {
            **self.headers,
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        if self.session_id is not None:
            headers["Mcp-Session-Id"] = self.session_id
        if self.protocol_version is not None:
            headers["MCP-Protocol-Version"] = self.protocol_version
        return headers

    async def _notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        await self._post_only(message)

    async def _post_only(self, message: dict[str, Any]) -> None:
        """POST a notification or response; the server answers 202 with no body."""
        try:
            resp = await self._client.post(self.url, json=message, headers=self._headers())
        except httpx.HTTPError as exc:
            raise McpError(f"MCP server at {self.url} unreachable: {exc}") from exc
        if resp.status_code >= 400:
            raise McpError(f"MCP server at {self.url} returned HTTP {resp.status_code}: {resp.text[:200]}", status=resp.status_code)

    async def _send(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """POST one JSON-RPC request and return its ``result``."""
        rid = next(self._ids)
        message = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
        try:
            async with self._client.stream("POST", self.url, json=message, headers=self._headers()) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread()).decode(errors="replace")
                    raise McpError(
                        f"MCP server at {self.url} returned HTTP {resp.status_code} for {method}: {body[:200]}",
                        status=resp.status_code,
                    )
                if method == "initialize" and resp.headers.get("mcp-session-id"):
                    self.session_id = resp.headers["mcp-session-id"]
                ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                if ctype == "text/event-stream":
                    reply = await self._read_sse(resp, rid)
                elif ctype == "application/json":
                    reply = _match(json.loads(await resp.aread()), rid)
                else:
                    raise McpError(f"MCP server at {self.url} sent unexpected content type {ctype!r} for {method}")
        except httpx.HTTPError as exc:
            raise McpError(f"MCP request {method} to {self.url} failed: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise McpError(f"MCP server at {self.url} sent invalid JSON for {method}: {exc}") from exc
        if reply is None:
            raise McpError(f"MCP server at {self.url} sent no response for {method}")
        if "error" in reply:
            err = reply["error"] or {}
            raise McpError(
                f"{err.get('message', 'JSON-RPC error')} (code {err.get('code')})", code=err.get("code"), data=err.get("data")
            )
        return reply.get("result") or {}

    async def _read_sse(self, resp: httpx.Response, rid: int) -> dict[str, Any] | None:
        async for data in _sse_messages(resp):
            payload = json.loads(data)
            for msg in payload if isinstance(payload, list) else [payload]:
                if not isinstance(msg, dict):
                    continue
                if "method" in msg and "id" in msg:
                    await self._answer_server_request(msg)
                elif msg.get("id") == rid and ("result" in msg or "error" in msg):
                    return msg
        return None

    async def _answer_server_request(self, msg: dict[str, Any]) -> None:
        if msg["method"] == "ping":
            reply: dict[str, Any] = {"jsonrpc": "2.0", "id": msg["id"], "result": {}}
        else:
            reply = {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "Method not found"}}
        try:
            await self._post_only(reply)
        except McpError:
            pass


def _match(payload: Any, rid: int) -> dict[str, Any] | None:
    for msg in payload if isinstance(payload, list) else [payload]:
        if isinstance(msg, dict) and msg.get("id") == rid:
            return msg
    return None


async def _sse_messages(resp: httpx.Response) -> Any:
    """Yield the ``data`` of each ``message`` event in an SSE stream."""
    data: list[str] = []
    event = "message"
    async for line in resp.aiter_lines():
        if line == "":
            if data and event == "message":
                yield "\n".join(data)
            data, event = [], "message"
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if field == "data":
            data.append(value)
        elif field == "event":
            event = value or "message"
    if data and event == "message":
        yield "\n".join(data)


def render_content(result: dict[str, Any]) -> str:
    """Render a ``tools/call`` result as text for the model."""
    parts: list[str] = []
    for item in result.get("content") or []:
        kind = item.get("type")
        if kind == "text":
            parts.append(item.get("text", ""))
        elif kind in ("image", "audio"):
            size = len(item.get("data") or "") * 3 // 4
            parts.append(f"[{kind}: {item.get('mimeType', 'unknown type')}, ~{size} bytes]")
        elif kind == "resource_link":
            parts.append(f"[resource link: {item.get('name') or ''} {item.get('uri', '')}]".replace("  ", " "))
        elif kind == "resource":
            res = item.get("resource") or {}
            if "text" in res:
                parts.append(f"[resource {res.get('uri', '')}]\n{res['text']}")
            else:
                parts.append(f"[resource {res.get('uri', '')}: {res.get('mimeType', 'binary')}]")
        else:
            parts.append(f"[{kind} content]")
    if not parts and result.get("structuredContent") is not None:
        return json.dumps(result["structuredContent"], ensure_ascii=False)
    return "\n".join(parts)


def mcp_tool_specs(server_name: str, tools: list[ToolSpec]) -> list[ToolSpec]:
    """Present a server's tools as ``<server>__<tool>``.

    Names are made safe for every vendor (``[a-zA-Z0-9_-]``, at most 64
    characters); ``options["mcp_tool"]`` keeps the original name for
    ``tools/call`` and ``options["mcp_server"]`` the server.
    """
    prefix = _NAME_OK.sub("_", server_name)
    out: list[ToolSpec] = []
    seen: set[str] = set()
    for t in tools:
        name = f"{prefix}__{_NAME_OK.sub('_', t.name)}"[:MAX_TOOL_NAME]
        base, n = name, 2
        while name in seen:
            suffix = f"_{n}"
            name, n = base[: MAX_TOOL_NAME - len(suffix)] + suffix, n + 1
        seen.add(name)
        out.append(
            ToolSpec(
                name=name,
                description=t.description,
                input_schema=t.input_schema,
                options={"mcp_server": server_name, "mcp_tool": t.name},
            )
        )
    return out
