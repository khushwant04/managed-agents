from __future__ import annotations

import textwrap

import pytest
from pydantic import BaseModel

from agents import Agent, Sandbox, Skill, tool
from agents.testing import ScriptedAdapter, call, scripted_registry, text


class DeployQuery(BaseModel):
    service: str
    minutes: int = 30


@tool(url="https://internal.example.com/tools/deploys")
def lookup_deploys(q: DeployQuery) -> list[dict]:
    """List deploys for a service in the last N minutes."""
    return [{"service": q.service, "minutes": q.minutes}]


def test_tool_schema_from_pydantic_model():
    spec = lookup_deploys.spec
    assert spec.name == "lookup_deploys"
    assert spec.description == "List deploys for a service in the last N minutes."
    assert set(spec.input_schema["properties"]) == {"service", "minutes"}
    assert spec.input_schema["required"] == ["service"]
    assert lookup_deploys.ref()["url"] == "https://internal.example.com/tools/deploys"
    assert lookup_deploys(DeployQuery(service="api")) == [{"service": "api", "minutes": 30}]


async def test_tool_invoke_validates_model_args():
    assert await lookup_deploys.invoke({"service": "api", "minutes": 5}) == '[{"service": "api", "minutes": 5}]'


def test_spec_hash_is_stable_and_changes_with_definition():
    a = Agent("incident-investigator", ["claude-opus-5-5", "gpt-6-astra"], "Investigate.", tools=["shell", lookup_deploys])
    b = Agent("incident-investigator", ["claude-opus-5-5", "gpt-6-astra"], "Investigate.", tools=["shell", lookup_deploys])
    c = Agent("incident-investigator", ["claude-opus-5-5"], "Investigate.", tools=["shell", lookup_deploys])
    assert a.version_hash == b.version_hash != c.version_hash


def test_agent_rejects_unknown_builtin_and_bad_names():
    with pytest.raises(ValueError):
        Agent("x", "claude-opus-5-5", tools=["teleport"])
    with pytest.raises(ValueError):
        Agent("Bad Name", "claude-opus-5-5")


def test_tool_refs_for_mcp_and_agents():
    helper = Agent("helper-bot", "claude-opus-5-5")
    agent = Agent(
        "a",
        "claude-opus-5-5",
        tools=[{"mcp": "https://obs.example.com/mcp", "secret": "OBS_TOKEN"}, helper, {"agent": "triage@prod"}],
    )
    refs = agent.spec().tools
    assert refs[0].type == "mcp" and refs[0].name == "obs" and refs[0].secrets == ["OBS_TOKEN"]
    assert refs[1].type == "agent" and refs[1].name == "call_helper_bot"
    assert refs[2].options == {"agent": "triage@prod"} and refs[2].name == "call_triage"


def test_sync_start_events_and_wait():
    adapter = ScriptedAdapter([call("shell", {"command": "echo synced"}, id="c1"), text("all good")])
    agent = Agent("sync", "scripted", tools=["shell"])
    with agent.start("go", sandbox=Sandbox.local(), adapters=scripted_registry(adapter)) as session:
        seen = list(session.events())
        assert seen[-1].type == "session.status" and seen[-1].payload["status"] == "idle"
        assert "".join(e.text for e in seen if e.type == "message.agent.delta").strip() == "all good"
        assert session.output == "all good"
        tool_results = [e for e in seen if e.type == "tool.result"]
        assert "synced" in tool_results[0].payload["content"]


def test_run_helper_returns_output():
    adapter = ScriptedAdapter([text("42")])
    assert Agent("q", "scripted").run("what?", adapters=scripted_registry(adapter)) == "42"


async def test_async_session_follow_up():
    adapter = ScriptedAdapter([text("one"), text("two")])
    async with await Agent("chat", "scripted").astart("first", adapters=scripted_registry(adapter)) as session:
        assert [e.type async for e in session.events()][-1] == "session.status"
        await session.send("second")
        async for _ in session.events():
            pass
        assert session.output == "two"


def test_skills_are_listed_and_copied(tmp_path):
    skill_dir = tmp_path / "runbooks"
    (skill_dir / "scripts").mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        textwrap.dedent(
            """\
            ---
            name: runbooks
            description: Incident runbooks for service-api
            ---
            # Runbooks
            Check the error budget first.
            """
        )
    )
    (skill_dir / "scripts" / "check.sh").write_text("echo ok\n")
    skill = Skill.from_path(skill_dir)
    assert skill.name == "runbooks" and skill.description == "Incident runbooks for service-api"
    adapter = ScriptedAdapter([call("shell", {"command": "cat /workspace/skills/runbooks/SKILL.md"}, id="c"), text("read it")])
    agent = Agent("ops", "scripted", "Investigate.", tools=["shell"], skills=[skill_dir])
    with agent.start("go", sandbox=Sandbox.local(), adapters=scripted_registry(adapter)) as session:
        session.wait()
    system = adapter.requests[0].system
    assert system.startswith("Investigate.")
    assert "runbooks (/workspace/skills/runbooks/SKILL.md): Incident runbooks" in system
    assert "Check the error budget first." in adapter.requests[1].messages[-1].content[0].content


def test_from_yaml(tmp_path):
    (tmp_path / "agent.yaml").write_text(
        textwrap.dedent(
            """\
            name: incident-investigator
            model: [claude-opus-5-5, gpt-6-astra]
            reasoning: high
            instructions: Investigate alerts.
            tools:
              - shell
              - files
              - mcp: https://obs.example.com/mcp
                secret: OBS_TOKEN
              - name: lookup_deploys
                url: https://internal.example.com/tools/deploys
                description: List deploys.
                input_schema: {type: object, properties: {service: {type: string}}}
                approval: never
            subagents: {max_concurrent: 3}
            model_options:
              anthropic: {cache: 1h}
            """
        )
    )
    agent = Agent.from_yaml(tmp_path / "agent.yaml")
    spec = agent.spec()
    assert spec.models == ["claude-opus-5-5", "gpt-6-astra"]
    assert [t.type for t in spec.tools] == ["builtin", "builtin", "mcp", "function"]
    assert spec.tools[3].url == "https://internal.example.com/tools/deploys"
    assert spec.model_options == {"anthropic": {"cache": "1h"}}
