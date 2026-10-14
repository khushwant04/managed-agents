from __future__ import annotations

import pytest
from agents.sandbox import Environment
from agents.sandbox.base import SandboxError, workspace_path
from agents.sandbox.local import LocalSandboxProvider
from agents.tools.approval import ExpressionError, parse_approval
from agents.tools.builtins import BUILTINS, code_to_command
from agents.tools.executor import CallContext, ToolExecutor
from agents.types import ToolCallBlock


def test_approval_policies():
    assert not parse_approval("never").requires_approval("shell", {})
    assert parse_approval("always").requires_approval("shell", {})
    p = parse_approval({"when": "'rm ' in args.command or args.command.startswith('git push')"})
    assert p.requires_approval("shell", {"command": "rm -rf /tmp/x"})
    assert p.requires_approval("shell", {"command": "git push origin main"})
    assert not p.requires_approval("shell", {"command": "ls"})
    amount = parse_approval({"when": "args.amount > 100 and tool == 'pay'"})
    assert amount.requires_approval("pay", {"amount": 101})
    assert not amount.requires_approval("pay", {"amount": 5})
    assert not amount.requires_approval("pay", {})  # missing field compares false
    nested = parse_approval({"when": "args.target.env == 'prod' or len(args.ids) > 2"})
    assert nested.requires_approval("x", {"target": {"env": "prod"}, "ids": []})
    assert nested.requires_approval("x", {"target": {}, "ids": [1, 2, 3]})


@pytest.mark.parametrize(
    "expr",
    ["__import__('os').system('x')", "args.__class__", "open('f')", "[x for x in args]", "lambda: 1"],
)
def test_approval_rejects_unsafe_expressions(expr):
    with pytest.raises(ExpressionError):
        parse_approval({"when": expr})


def test_workspace_paths():
    assert workspace_path("notes.txt") == "/workspace/notes.txt"
    assert workspace_path("/workspace/a/../b") == "/workspace/b"
    for bad in ("/etc/passwd", "/workspace/../etc", "../x"):
        with pytest.raises(SandboxError):
            workspace_path(bad)


def test_code_to_command_quotes():
    assert code_to_command("python", "print('hi')") == "python3 -c 'print('\"'\"'hi'\"'\"')'"


async def _executor():
    provider = LocalSandboxProvider()
    handle = await provider.create(Environment(provider="local"))
    specs = {n: BUILTINS[n] for n in ("shell", "files", "code")}
    return ToolExecutor(specs, sandbox=provider, handle=handle), provider, handle


async def run(ex, name, args, cid="c"):
    return await ex.execute(
        ToolCallBlock(id=cid, name=name, arguments=args), CallContext(session_id="s", run_id="r", call_id=cid, idempotency_key="k")
    )


async def test_files_create_view_replace_insert():
    ex, provider, handle = await _executor()
    p = "/workspace/notes.md"
    assert not (await run(ex, "files", {"command": "create", "path": p, "file_text": "one\ntwo\nthree\n"})).is_error
    view = await run(ex, "files", {"command": "view", "path": p, "view_range": [2, 3]})
    assert view.content == "     2\ttwo\n     3\tthree"
    assert not (await run(ex, "files", {"command": "str_replace", "path": p, "old_str": "two", "new_str": "TWO"})).is_error
    missing = await run(ex, "files", {"command": "str_replace", "path": p, "old_str": "zzz", "new_str": ""})
    assert missing.is_error and "not found" in missing.content
    await run(ex, "files", {"command": "create", "path": "/workspace/dup.txt", "file_text": "a a"})
    dup = await run(ex, "files", {"command": "str_replace", "path": "/workspace/dup.txt", "old_str": "a", "new_str": "b"})
    assert dup.is_error and "2 times" in dup.content
    assert not (await run(ex, "files", {"command": "insert", "path": p, "insert_line": 1, "new_str": "one-and-a-half"})).is_error
    content = (await provider.read_files(handle, [p]))[0].text
    assert content == "one\none-and-a-half\nTWO\nthree\n"
    listing = await run(ex, "files", {"command": "view", "path": "/workspace"})
    assert "notes.md" in listing.content
    escape = await run(ex, "files", {"command": "view", "path": "/etc/passwd"})
    assert escape.is_error and "outside /workspace" in escape.content
    await provider.destroy(handle)


async def test_shell_and_code_and_timeouts():
    ex, provider, handle = await _executor()
    out = await run(ex, "shell", {"command": "pwd && echo err >&2 && exit 3"})
    assert "[exit code 3]" in out.content and "[stderr]\nerr" in out.content
    code = await run(ex, "code", {"language": "python", "code": "print(6*7)"})
    assert code.content.startswith("42")
    slow = await run(ex, "shell", {"command": "sleep 5", "timeout": 0.2})
    assert "[timed out]" in slow.content
    await provider.destroy(handle)


async def test_executor_without_sandbox_reports_error():
    ex = ToolExecutor({"shell": BUILTINS["shell"]})
    res = await run(ex, "shell", {"command": "ls"})
    assert res.is_error and "no sandbox" in res.content
