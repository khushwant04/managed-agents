"""Executes canonical tool calls. The runtime, not the model, decides where (ADR-0009)."""

from __future__ import annotations

import html
import re
import shlex
from collections.abc import Awaitable, Callable
from typing import Any

import jsonschema

from ..sandbox.base import SandboxError, SandboxHandle, SandboxProvider, workspace_path
from ..types import ToolCallBlock, ToolResultBlock, ToolSpec
from .builtins import code_to_command
from .function import FunctionTool

ToolHandler = Callable[[dict[str, Any], "CallContext"], Awaitable[str]]
"""A runtime-provided tool: ``call_agent``, ``spawn_subagent``, MCP tools, webhooks."""

MAX_RESULT_CHARS = 50_000


class ToolExecutionError(Exception):
    """Raised by handlers for an error the model should see as a failed result."""


class CallContext:
    def __init__(self, *, session_id: str, run_id: str, call_id: str, idempotency_key: str) -> None:
        self.session_id = session_id
        self.run_id = run_id
        self.call_id = call_id
        self.idempotency_key = idempotency_key


class ToolExecutor:
    def __init__(
        self,
        specs: dict[str, ToolSpec],
        *,
        sandbox: SandboxProvider | None = None,
        handle: SandboxHandle | None = None,
        functions: dict[str, FunctionTool] | None = None,
        handlers: dict[str, ToolHandler] | None = None,
        web_search: ToolHandler | None = None,
        shell_timeout: float = 300,
    ) -> None:
        self.specs = specs
        self.sandbox = sandbox
        self.handle = handle
        self.functions = functions or {}
        self.handlers = handlers or {}
        self.web_search = web_search
        self.shell_timeout = shell_timeout

    async def execute(self, call: ToolCallBlock, ctx: CallContext) -> ToolResultBlock:
        def result(content: str, is_error: bool = False) -> ToolResultBlock:
            if len(content) > MAX_RESULT_CHARS:
                content = content[:MAX_RESULT_CHARS] + f"\n[... truncated {len(content) - MAX_RESULT_CHARS} characters]"
            return ToolResultBlock(call_id=call.id, content=content, is_error=is_error, native_name=call.native_name)

        if call.parse_error:
            return result(f"{call.parse_error}. Send the tool call again with valid JSON arguments.", True)
        spec = self.specs.get(call.name)
        if spec is None:
            return result(f"Unknown tool {call.name!r}.", True)
        try:
            jsonschema.validate(call.arguments, spec.input_schema)
        except jsonschema.ValidationError as exc:
            return result(f"Invalid arguments for {call.name}: {exc.message}", True)
        try:
            return result(await self._dispatch(call, spec, ctx))
        except (ToolExecutionError, SandboxError, ValueError) as exc:
            return result(str(exc), True)

    async def _dispatch(self, call: ToolCallBlock, spec: ToolSpec, ctx: CallContext) -> str:
        args = call.arguments
        if call.name in self.handlers:
            return await self.handlers[call.name](args, ctx)
        if spec.kind == "builtin":
            if call.name == "shell":
                if args.get("restart"):
                    return "Shell restarted. Each command runs in a fresh shell in /workspace."
                return await self._exec(args.get("command", ""), args.get("timeout"))
            if call.name == "code":
                return await self._exec(code_to_command(args["language"], args["code"]), None)
            if call.name == "files":
                return await self._files(args)
            if call.name == "web_fetch":
                return await web_fetch(args["url"])
            if call.name == "web_search":
                if self.web_search is None:
                    raise ToolExecutionError("web_search is not available for this model and no search backend is configured.")
                return await self.web_search(args, ctx)
        fn = self.functions.get(call.name)
        if fn is not None and fn.fn is not None:
            return await fn.invoke(args)
        raise ToolExecutionError(f"Tool {call.name!r} has no executor in this runtime.")

    def _require_sandbox(self) -> tuple[SandboxProvider, SandboxHandle]:
        if self.sandbox is None or self.handle is None:
            raise ToolExecutionError("This session has no sandbox.")
        return self.sandbox, self.handle

    async def _exec(self, command: str, timeout: float | None) -> str:
        sandbox, handle = self._require_sandbox()
        res = await sandbox.exec(handle, command, timeout=min(timeout or self.shell_timeout, self.shell_timeout))
        return res.render()

    async def _files(self, args: dict[str, Any]) -> str:
        sandbox, handle = self._require_sandbox()
        command = args["command"]
        path = workspace_path(args["path"])
        if command == "create":
            from ..sandbox.base import FileSpec

            await sandbox.write_files(handle, [FileSpec(path=path, content=args.get("file_text", "").encode())])
            return f"File created: {path}"
        if command == "view":
            probe = await sandbox.exec(handle, f"test -d {shlex.quote(path)} && echo dir || echo file", timeout=30)
            if probe.stdout.strip() == "dir":
                listing = await sandbox.exec(
                    handle,
                    f"find {shlex.quote(path)} -maxdepth 2 -not -path '*/.*' | sort | head -500",
                    timeout=30,
                )
                return listing.stdout or "(empty directory)"
            text = (await sandbox.read_files(handle, [path]))[0].text
            lines = text.splitlines()
            start, end = 1, len(lines)
            if args.get("view_range"):
                start, end = args["view_range"]
                end = len(lines) if end == -1 else end
            return "\n".join(f"{i:6}\t{lines[i - 1]}" for i in range(max(start, 1), min(end, len(lines)) + 1))
        text = (await sandbox.read_files(handle, [path]))[0].text
        if command == "str_replace":
            old, new = args.get("old_str", ""), args.get("new_str", "")
            count = text.count(old) if old else 0
            if count == 0:
                raise ToolExecutionError(f"old_str not found in {path}; no change made.")
            if count > 1:
                raise ToolExecutionError(f"old_str appears {count} times in {path}; make it unique.")
            text = text.replace(old, new, 1)
        elif command == "insert":
            lines = text.splitlines(keepends=True)
            at = args.get("insert_line", 0)
            if not 0 <= at <= len(lines):
                raise ToolExecutionError(f"insert_line {at} is out of range (0-{len(lines)}).")
            new = args.get("new_str", "")
            lines.insert(at, new if new.endswith("\n") else new + "\n")
            text = "".join(lines)
        from ..sandbox.base import FileSpec

        await sandbox.write_files(handle, [FileSpec(path=path, content=text.encode())])
        return f"File edited: {path}"


_TAG = re.compile(r"<(script|style)[^>]*>.*?</\1>|<[^>]+>", re.S | re.I)


async def web_fetch(url: str, *, timeout: float = 30, limit: int = 40_000) -> str:
    """Fallback ``web_fetch`` for models without a server-side fetch tool."""
    import httpx

    if not url.startswith(("http://", "https://")):
        raise ToolExecutionError("Only http(s) URLs can be fetched.")
    async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
        resp = await client.get(url, headers={"User-Agent": "managed-agents/0.1 (+web_fetch)"})
    body = resp.text
    if "html" in resp.headers.get("content-type", ""):
        body = html.unescape(_TAG.sub(" ", body))
        body = re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n\n", body)).strip()
    return f"[{resp.status_code}] {url}\n\n{body[:limit]}"
