# Python SDK

Python ships first and holds the full runtime ([ADR-0012](../adr/0012-python-first-typescript-generated.md)). One agent definition runs locally in a script, then registers and deploys to your platform unchanged.

> The import name `agents` and the distribution names below are placeholders until [ADR-0015](../adr/0015-package-and-install-names.md) is decided: `agents` collides with OpenAI's Agents SDK.

## Packages (one monorepo)

| Package (distribution) | Import | Contents |
| --- | --- | --- |
| `managed-agents` | `agents` | `Agent`, `tool`, `Skill`, `Sandbox`, the runtime, model adapters, sandbox providers, MCP and webhook tools, `Client` / `AsyncClient`; asyncio, httpx, Pydantic. Extra `e2b` for E2B sandboxes |
| `managed-agents-server` | `agents_server` | Gateway, registry, router, workers, scheduler; `agents-server` command. Extras `s3`, `otel` |
| `managed-agents-cli` | `agents_cli` | The `agents` command |
| `@managed-agents/client` (npm) | | TypeScript client generated from the OpenAPI spec ([TypeScript SDK](typescript.md)) |
| `@managed-agents/react` (npm) | | Optional hooks (`useSession`, `useEvents`) |

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
version = client.agents.register(investigator).version   # uploads local skills first
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

The full, runnable version of this agent is [examples/incident-investigator](../../examples/incident-investigator/README.md).

## Agents

`Agent(name, model, instructions, *, tools, skills, reasoning, subagents, model_options, limits, environment, description, input_schema, tags)`

- `model`: one model or an ordered list; later models are fallbacks on 429, 5xx, connection errors and refusals. Names resolve by prefix (`claude-*` → Anthropic, `gpt-*`/`o*` → OpenAI); `vendor/model` is explicit, and `<endpoint>/<model>` addresses a registered OpenAI-compatible endpoint.
- `tools`: built-in names (`"shell"`, `"files"`, `"code"`, `"web_search"`, `"web_fetch"`), `@tool` functions, `{"mcp": url, "secret": NAME}`, other `Agent` objects or `{"agent": "name@alias"}` (exposed as `call_<name>`), and `{"builtin": "shell", "approval": ...}` to put a policy on a built-in.
- `limits`: `max_steps`, `max_tokens` (per run), `max_wall_clock_s`, `max_output_tokens`, `compact_at_tokens`.
- `Agent.from_yaml("agent.yaml")` loads the same definition from YAML; `agent.spec()` is the serializable, content-hashed definition the registry stores.

## Tools

```python
@tool                                             # in-process (local runs only)
def add(a: int, b: int) -> int: ...

@tool(url="https://tools.example.com/deploys")    # hosted: HMAC-signed webhook with an idempotency key
def lookup_deploys(q: DeployQuery) -> list[dict]: ...

@tool(sandbox=True)                               # hosted: source shipped with the version, run in the sandbox
def word_count(text: str) -> dict: ...

@tool(approval={"when": "args.amount > 100"})     # pause the run for a human decision
def pay(amount: int) -> str: ...
```

Schemas come from type hints; a function taking a single Pydantic model receives the validated model. Approval expressions are described in [ADR-0020](../adr/0020-approval-expression-language.md). Webhook receivers verify calls with `agents.tools.webhook.verify(secret, header, body)`.

## Sessions

`agent.start(...)` returns a `Session` (sync); `await agent.astart(...)` an `AsyncSession`. Hosted sessions from `client.invoke(...)` have the same methods.

| Method | Does |
| --- | --- |
| `events()` | Yields events until the current run settles (idle, waiting for input or approval, failed); call again after `send` or `approve` |
| `send(text)` | Steers the running run at its next step boundary, or starts a new run |
| `approve(call_id, approved=True, reason=None)` / `deny(...)` | Decides a pending tool approval; the run resumes when all are decided |
| `interrupt()` | Cancels the in-flight run |
| `wait()` | Waits for the current run; `output` holds its final text |
| `artifacts()` | Files written to `/workspace/outputs` |
| `close()` | Terminates the session and its sandbox |

Every call has a sync and an async form (`Client` / `AsyncClient`, `session.events()` / `async for`).

## Client

`Client` and `AsyncClient` cover the REST API: `agents` (`register`, `versions`, `get`, `search`, `set_alias`, `promote`, `canary`, `rollback`, `aliases`, `card`), `deployments` (`create`, `list`, `get`, `update`, `pause`, `resume`, `delete`, `invoke`), `sessions` (`get`, `list`, `attach`, `send`, `approve`, `interrupt`, `terminate`, `artifacts`, `download`), `secrets`, `environments`, plus `invoke` and `run` (wait for the result). Event streams reconnect with `Last-Event-ID` after a dropped connection. Errors raise `APIError` with `status` and, for rejected definitions, `problems`.

## CLI

```bash
agents run agent.yaml "5xx spike on service-api"            # local run; saves /workspace/outputs
agents dev                                                  # gateway + worker + scheduler on this machine
agents apply agent.yaml --promote prod                      # register a version and move an alias
agents deploy incident-investigator --http --cron "*/30 * * * *" --input "Check error budgets" --webhook github
agents promote incident-investigator 15 --canary 10         # 10% of new sessions to v15
agents rollback incident-investigator
agents invoke incident-investigator@prod "Why did p99 latency jump?"
agents versions incident-investigator
agents sessions list | tail <id> | send <id> "text" | approve <id> <call-id> | interrupt <id> | artifacts <id>
agents deployments list | pause <name> | resume <name> | delete <name>
agents secrets set OBS_TOKEN < token.txt
```

Agents can be given as `agent.yaml`, `path/to/file.py[:variable]` or `module:variable`.

## Testing without API keys

- `agents.testing.ScriptedAdapter` plays back scripted model turns (`text(...)`, `call(...)`, `calls(...)`); register it with `scripted_registry(...)` and pass `adapters=` to `start`/`astart`.
- Adapter contract tests replay recorded raw stream events (`FakeAnthropicClient`, fixtures under `packages/agents/tests/fixtures`); refresh them with `scripts/record_fixtures.py`.
- `pytest -m live` runs the live tests when `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are set.
