# Managed Agents

An open-source, self-hosted managed-agents platform. Register an agent once, and the platform hosts it, routes every request to the right agent and version, and runs it on its own harness against Claude or OpenAI models, using each model API's native features.

> **Status:** v0.1 implemented, not yet released. The Python SDK, runtime, adapters, server, CLI and the incident-investigator demo are built and tested on scripted and recorded model responses; live API runs, the E2B template build and the first PyPI release are next. See the [roadmap](docs/roadmap.md).

## What it does

- **Register:** agents are versioned definitions (model, instructions, tools, skills, policies) pushed from code, YAML or the API, with movable aliases such as `prod` and `canary`.
- **Route:** one gateway resolves `name@alias` to a version, splits traffic between versions, picks a model with fallbacks, and lets agents call other agents.
- **Host:** deployments expose agents through HTTP, webhook, cron and queue triggers, with durable sessions that survive worker crashes and stream events over SSE or WebSocket.
- **Run:** the project's own agent loop (tool calling, compaction, subagents, steering, approvals) on thin adapters for the Anthropic Messages API, the OpenAI Responses API and any OpenAI-compatible endpoint.
- **Sandbox:** each session gets an [E2B](https://e2b.dev) sandbox for shell, files and code (Docker or a local directory for development).

Claude Managed Agents and OpenAI's Agents API are reference designs, not dependencies: the project only calls model inference APIs.

## Quickstart

```bash
uv sync                                   # Python 3.11+; installs the workspace
export ANTHROPIC_API_KEY=...              # and/or OPENAI_API_KEY
```

**Run an agent locally** (embedded runtime, no server):

```python
from agents import Agent, Sandbox

agent = Agent(
    name="incident-investigator",
    model=["claude-opus-5-5", "gpt-6-astra"],   # primary, then fallback
    reasoning="high",
    instructions="Investigate alerts. Write findings to /workspace/outputs/report.md.",
    tools=["shell", "files", "web_search"],
)
session = agent.start("5xx spike on service-api", sandbox=Sandbox.local())
for ev in session.events():
    if ev.type == "message.agent.delta":
        print(ev.text, end="")
```

**Host it** with Postgres, a gateway, workers and a scheduler:

```bash
docker compose up -d                                   # or: uv run agents dev (needs Postgres)
export AGENTS_BASE_URL=http://localhost:8080 AGENTS_API_KEY=ak_dev_admin
uv run agents apply examples/incident-investigator/agent.py --promote prod
uv run agents deploy incident-investigator --http --cron "*/30 * * * *" --input "Check error budgets"
uv run agents invoke incident-investigator@prod "Why did p99 latency jump?"
```

Or from Python with `Client` / `AsyncClient` ([Python SDK](docs/sdk/python.md)), or TypeScript ([TypeScript SDK](docs/sdk/typescript.md)).

## Repository layout

| Path | What |
| --- | --- |
| `packages/agents` | Python SDK and runtime: `Agent`, `tool`, `Skill`, the runner, model adapters, sandbox providers, MCP and webhook tools, `Client` |
| `packages/agents-server` | Gateway (FastAPI), registry, router, run queue, workers, scheduler, secrets, metrics |
| `packages/agents-cli` | The `agents` command |
| `typescript/` | TypeScript client generated from the OpenAPI spec, plus React hooks |
| `dashboard/` | Next.js dashboard: agents, versions, deployments, session timelines and replay |
| `examples/incident-investigator` | The flagship demo, its tools service and the Claude vs. GPT benchmark |
| `infra/`, `deploy/`, `docker-compose.yml` | E2B sandbox template, Helm chart, Compose stack |
| `docs/` | Design plan, architecture, ADRs, API reference (`docs/api/openapi.json`) |

## Development

```bash
uv sync
uv run ruff check packages examples
uv run pytest -q                 # unit, contract and Postgres-backed tests (starts a throwaway Postgres)
uv run pytest -q -m live         # live API tests (need API keys)
```

Server tests use `TEST_DATABASE_URL` when set, otherwise they start a temporary cluster with the local PostgreSQL binaries. Model calls in tests are scripted or replayed from recorded stream events, so no API keys are needed.

## Documentation

| Doc | What it covers |
| --- | --- |
| [Design plan](docs/design-plan.md) | The full SDK and infrastructure plan this repo is built from |
| [Architecture overview](docs/architecture/overview.md) | Control plane, data plane, request path |
| [Core abstractions](docs/architecture/core-abstractions.md) | The twelve objects and the event schema |
| [Registration, routing and hosting](docs/architecture/registry-routing-hosting.md) | Registry, router, deployments, triggers |
| [Agent runtime](docs/architecture/runtime.md) | The harness: loop, checkpoints, steering, compaction |
| [Model adapters](docs/architecture/model-adapters.md) | Anthropic, OpenAI and OpenAI-compatible adapters |
| [Tools, skills and memory](docs/architecture/tools-skills-memory.md) | Where tools run, approvals, secrets, skills, memory |
| [Infrastructure](docs/architecture/infrastructure.md) | Components, data stores, sandboxes, deployment |
| [Security and operations](docs/architecture/security-operations.md) | Trust zones, tenancy, observability, cost controls |
| [Python SDK](docs/sdk/python.md) · [TypeScript SDK](docs/sdk/typescript.md) | SDKs and the CLI |
| [REST API](docs/api/rest.md) | Server REST surface (v1) |
| [Reference designs](docs/reference-designs.md) | Claude Managed Agents and OpenAI Agents API compared |
| [Roadmap and risks](docs/roadmap.md) | Phases, gates, risks, open questions |
| [ADRs](docs/adr/README.md) | Architecture decision records |

## License

The plan proposes Apache-2.0; the choice is still open in [ADR-0016](docs/adr/0016-license.md). A `LICENSE` file will be added once it is accepted.
