"""Record raw model stream events as test fixtures (needs real API keys).

    uv run python scripts/record_fixtures.py anthropic tool_turn "List pods with kubectl" --tools shell
    uv run python scripts/record_fixtures.py openai text_turn "Say hello" --model gpt-6-astra

Requests are built by the adapter under test, so a fixture records exactly what
the adapter would send and receive.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from runhive.tools.builtins import builtin
from runhive.types import Message, ModelRequest

FIXTURES = Path(__file__).resolve().parent.parent / "packages" / "runhive" / "tests" / "fixtures"


def _dump(event: object) -> dict:
    for attr in ("to_dict", "model_dump"):
        fn = getattr(event, attr, None)
        if fn is not None:
            return fn()
    raise TypeError(event)


async def record(vendor: str, name: str, prompt: str, model: str | None, tools: list[str]) -> Path:
    req = ModelRequest(
        model=model or ("claude-opus-5-5" if vendor == "anthropic" else "gpt-6-astra"),
        messages=[Message.user(prompt)],
        tools=[builtin(t) for t in tools],
        max_tokens=4096,
    )
    if vendor == "anthropic":
        from runhive.adapters.anthropic import AnthropicAdapter

        adapter = AnthropicAdapter()
        stream = await adapter.client.beta.messages.create(stream=True, **adapter.build_params(req))
    elif vendor == "openai":
        from runhive.adapters.openai import OpenAIAdapter

        adapter = OpenAIAdapter()
        stream = await adapter.client.responses.create(stream=True, **adapter.build_params(req))
    else:
        raise SystemExit(f"unknown vendor {vendor}")
    events = [_dump(e) async for e in stream]
    out = FIXTURES / vendor.replace("-", "_") / f"{name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(events, indent=1) + "\n")
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("vendor", choices=["anthropic", "openai"])
    p.add_argument("name")
    p.add_argument("prompt")
    p.add_argument("--model")
    p.add_argument("--tools", nargs="*", default=[])
    a = p.parse_args()
    print(asyncio.run(record(a.vendor, a.name, a.prompt, a.model, a.tools)))


if __name__ == "__main__":
    main()
