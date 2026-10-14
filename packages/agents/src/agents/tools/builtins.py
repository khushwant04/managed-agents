"""Portable built-in tools (ADR-0009).

``shell``, ``files`` and ``code`` always execute in the session sandbox so
behavior is identical across models; adapters present them to each model with
its native schema and translate calls into the canonical arguments below.
``web_search`` and ``web_fetch`` use the vendor's server-side tool when the
model has one, otherwise the runtime's fallback implementation.
"""

from __future__ import annotations

import shlex
from typing import Any

from ..types import ToolSpec

SHELL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "command": {"type": "string", "description": "Bash command to run in /workspace."},
        "timeout": {"type": "number", "description": "Timeout in seconds."},
        "restart": {"type": "boolean", "description": "Restart the shell session."},
    },
    "additionalProperties": False,
}

FILES_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "command": {"type": "string", "enum": ["view", "create", "str_replace", "insert"]},
        "path": {"type": "string", "description": "Absolute path, under /workspace."},
        "file_text": {"type": "string", "description": "Content for create."},
        "old_str": {"type": "string", "description": "Exact text to replace (str_replace)."},
        "new_str": {"type": "string", "description": "Replacement text (str_replace, insert)."},
        "insert_line": {"type": "integer", "description": "Line after which to insert (insert)."},
        "view_range": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
    },
    "required": ["command", "path"],
    "additionalProperties": False,
}

CODE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "language": {"type": "string", "enum": ["python", "node", "bash"]},
        "code": {"type": "string"},
    },
    "required": ["language", "code"],
    "additionalProperties": False,
}

WEB_SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"query": {"type": "string"}},
    "required": ["query"],
    "additionalProperties": False,
}

WEB_FETCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"url": {"type": "string"}},
    "required": ["url"],
    "additionalProperties": False,
}

BUILTINS: dict[str, ToolSpec] = {
    "shell": ToolSpec(
        name="shell",
        kind="builtin",
        description="Run a bash command in the session sandbox. The working directory is /workspace.",
        input_schema=SHELL_SCHEMA,
    ),
    "files": ToolSpec(
        name="files",
        kind="builtin",
        description=(
            "View, create and edit files in the session sandbox. `view` shows a file with line "
            "numbers or lists a directory; `create` writes a file; `str_replace` replaces one exact "
            "occurrence of `old_str`; `insert` adds `new_str` after `insert_line`."
        ),
        input_schema=FILES_SCHEMA,
    ),
    "code": ToolSpec(
        name="code",
        kind="builtin",
        description="Run a snippet of Python, Node or bash in the session sandbox and return its output.",
        input_schema=CODE_SCHEMA,
    ),
    "web_search": ToolSpec(
        name="web_search",
        kind="builtin",
        description="Search the web.",
        input_schema=WEB_SEARCH_SCHEMA,
    ),
    "web_fetch": ToolSpec(
        name="web_fetch",
        kind="builtin",
        description="Fetch a web page and return its text.",
        input_schema=WEB_FETCH_SCHEMA,
    ),
}

SERVER_SIDE_CAPABLE = frozenset({"web_search", "web_fetch"})


def builtin(name: str, **options: Any) -> ToolSpec:
    try:
        spec = BUILTINS[name]
    except KeyError:
        raise ValueError(f"unknown built-in tool {name!r}; expected one of {sorted(BUILTINS)}") from None
    return spec.model_copy(update={"options": options}) if options else spec


def code_to_command(language: str, code: str) -> str:
    """Turn a ``code`` call into a shell command for the sandbox."""
    interpreter = {"python": "python3", "node": "node", "bash": "bash"}[language]
    flag = "-c" if language != "node" else "-e"
    return f"{interpreter} {flag} {shlex.quote(code)}"
