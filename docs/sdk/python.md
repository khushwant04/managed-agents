# Python SDK

Python ships first and holds the full runtime ([ADR-0012](../adr/0012-python-first-typescript-generated.md)). One agent definition runs locally in a script, then registers and deploys to your platform unchanged.

> The import name `agents` is a placeholder until [ADR-0015](../adr/0015-package-and-install-names.md) is decided: it collides with OpenAI's Agents SDK.

## Packages (one monorepo)

| Order | Package | Contents |
| --- | --- | --- |
| 1 | `agents` (PyPI) | `Agent`, `tool`, `Skill`, the runtime, model adapters, sandbox providers, `Client` and `AsyncClient`; built on asyncio, httpx and Pydantic |
| 1 | `agents-server` (Python) | FastAPI gateway, registry, router, scheduler and runtime workers, reusing the `agents` runtime |
| 1 | `agents-cli` | `agents dev`, `agents apply`, `agents deploy`, `agents promote`, `agents sessions tail` |
| 2 | `agents` (npm) | `Client` and `Agent` definitions generated from the server's OpenAPI spec; local runtime later ([TypeScript SDK](typescript.md)) |
| 3 | `agents-react` | Optional hooks (`useSession`, `useEvents`) |

## Define, run locally, register, deploy, invoke

```python
from agents import Agent, Client, Sandbox, tool
from pydantic import BaseModel

class DeployQuery(BaseModel):
    service: str
    minutes: int

@tool(url="https://internal.example.com/tools/deploys")  # hosted: called as a signed webhook
def lookup_deploys(q: DeployQuery) -> list[dict]:
    """List deploys for a service in the last N minutes."""
    return fetch_deploys(q.service, q.minutes)            # used when running locally

investigator = Agent(
    name="incident-investigator",
    model=["claude-opus-5-5", "gpt-6-astra"],             # primary, then fallback
    reasoning="high",
    instructions="Investigate alerts. Write findings to /workspace/outputs/report.md.",
    tools=["shell", "files", "web_search", lookup_deploys,
           {"mcp": "https://obs.example.com/mcp", "secret": "OBS_TOKEN"}],
    skills=["./skills/runbooks"],
    subagents={"max_concurrent": 3},
    model_options={"anthropic": {"cache": "1h"}},
)

# 1. Run locally: embedded runtime, E2B sandbox, no server
session = investigator.start(input="5xx spike on service-api", sandbox=Sandbox.e2b())
for ev in session.events():
    if ev.type == "message.agent.delta":
        print(ev.text, end="")

# 2. Register and deploy to your platform
client = Client(base_url="https://agents.example.com")  # reads AGENTS_API_KEY
version = client.agents.register(investigator).version
client.deployments.create(
    agent="incident-investigator", alias="prod", version=version,
    triggers=[{"type": "http"},
              {"type": "cron", "schedule": "*/30 * * * *", "input": "Check error budgets"}],
)

# 3. Invoke through the router from anywhere
remote = client.invoke("incident-investigator@prod", input="Why did p99 latency jump?")
for ev in remote.events():
    ...  # same events as local
```

## Conventions

- **Sync and async:** every call has both forms: `Client` / `AsyncClient`, `session.events()` / `async for ev in session.events()`.
- **Tools:** decorated functions run in-process locally; hosted deployments call them as signed webhooks (`url`) or as scripts in the sandbox.
- **Sandboxes:** `Sandbox.e2b()` by default; a Docker provider for local development.
- **Events:** local and remote sessions emit the same [event types](../architecture/core-abstractions.md#event-schema).
- **Model options:** portable options (`reasoning`) are top-level; vendor fields go in `model_options["anthropic"]` / `model_options["openai"]` and are flagged non-portable ([ADR-0003](../adr/0003-native-features-through-adapters.md)).

## Developer experience

- Agents can live as YAML in a repo and be pushed with `agents apply agent.yaml`.
- `agents dev` runs gateway, worker and a Docker sandbox locally.
- pytest fixtures replay recorded model responses so contributors don't need API keys.
