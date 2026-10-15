"""Live contract tests against the real model APIs (nightly; `pytest -m live`).

Skipped without API keys. Models are configurable so the nightly job can
track new releases: LIVE_ANTHROPIC_MODEL, LIVE_OPENAI_MODEL.
"""

from __future__ import annotations

import os

import pytest

from runhive import Agent, Sandbox

pytestmark = pytest.mark.live

TARGETS = [
    pytest.param(
        os.environ.get("LIVE_ANTHROPIC_MODEL", "claude-opus-5-5"),
        marks=pytest.mark.skipif(not os.environ.get("ANTHROPIC_API_KEY"), reason="ANTHROPIC_API_KEY not set"),
        id="anthropic",
    ),
    pytest.param(
        os.environ.get("LIVE_OPENAI_MODEL", "gpt-6-astra"),
        marks=pytest.mark.skipif(not os.environ.get("OPENAI_API_KEY"), reason="OPENAI_API_KEY not set"),
        id="openai",
    ),
]


@pytest.mark.parametrize("model", TARGETS)
async def test_text_turn(model):
    agent = Agent("live-text", model, "Answer with one word.", limits={"max_output_tokens": 2000})
    session = await agent.astart("What is the capital of France?")
    async for _ in session.events():
        pass
    assert session.result.stop_reason == "end_turn", session.result.error
    assert "paris" in session.output.lower()
    assert session.result.usage.output_tokens > 0
    await session.close()


@pytest.mark.parametrize("model", TARGETS)
async def test_tool_turn_runs_in_sandbox(model):
    agent = Agent(
        "live-tools",
        model,
        "Use the shell tool to answer. Reply with only the number.",
        tools=["shell", "files"],
        reasoning="low",
        limits={"max_steps": 6},
    )
    session = await agent.astart("Compute 1234 * 5678 with python3 in the shell.", sandbox=Sandbox.local())
    calls = [ev async for ev in session.events() if ev.type == "tool.call"]
    assert calls and calls[0].payload["name"] == "shell"
    assert "7006652" in session.output.replace(",", "")
    await session.close()


@pytest.mark.parametrize("model", TARGETS)
async def test_follow_up_keeps_transcript(model):
    agent = Agent("live-chat", model, "Be brief.")
    session = await agent.astart("My favourite colour is teal. Just say OK.")
    async for _ in session.events():
        pass
    await session.send("What is my favourite colour?")
    async for _ in session.events():
        pass
    assert "teal" in session.output.lower()
    await session.close()
