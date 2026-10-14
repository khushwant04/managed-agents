# Managed Agents

An open-source, self-hosted managed-agents platform. Register an agent once, and the platform hosts it, routes every request to the right agent and version, and runs it on its own harness against Claude or OpenAI models, using each model API's native features.

> **Status:** design phase. This repository currently holds the design docs and architecture decision records (ADRs). Code lands with v0.1 (target: about 8 weeks, see the [roadmap](docs/roadmap.md)).

## What it does

- **Register:** agents are versioned definitions (model, instructions, tools, skills, policies) pushed from code, YAML or the API, with movable aliases such as `prod` and `canary`.
- **Route:** one gateway resolves `name@alias` to a version, splits traffic between versions, picks a model with fallbacks, and lets agents call other agents.
- **Host:** deployments expose agents through HTTP, webhook, cron and queue triggers, with durable sessions that survive worker crashes and stream events over SSE or WebSocket.
- **Run:** the project's own agent loop (tool calling, compaction, subagents, steering, approvals) on thin adapters for the Anthropic Messages API, the OpenAI Responses API and any OpenAI-compatible endpoint.
- **Sandbox:** each session gets an [E2B](https://e2b.dev) sandbox for shell, files and code.

Claude Managed Agents and OpenAI's Agents API are reference designs, not dependencies: the project only calls model inference APIs.

## A taste of the SDK

```python
from agents import Agent, Client, Sandbox

investigator = Agent(
    name="incident-investigator",
    model=["claude-opus-5-5", "gpt-6-astra"],   # primary, then fallback
    reasoning="high",
    instructions="Investigate alerts. Write findings to /workspace/outputs/report.md.",
    tools=["shell", "files", "web_search"],
)

# Run locally: embedded runtime, E2B sandbox, no server
session = investigator.start(input="5xx spike on service-api", sandbox=Sandbox.e2b())

# Or register, deploy and invoke through the router
client = Client(base_url="https://agents.example.com")
version = client.agents.register(investigator).version
client.deployments.create(agent="incident-investigator", alias="prod", version=version,
                          triggers=[{"type": "http"}])
remote = client.invoke("incident-investigator@prod", input="Why did p99 latency jump?")
```

See the [Python SDK](docs/sdk/python.md) for the full example.

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
| [Python SDK](docs/sdk/python.md) · [TypeScript SDK](docs/sdk/typescript.md) | SDK design and packages |
| [REST API](docs/api/rest.md) | Server REST surface (v1) |
| [Reference designs](docs/reference-designs.md) | Claude Managed Agents and OpenAI Agents API compared |
| [Roadmap and risks](docs/roadmap.md) | Phases, gates, risks, open questions |
| [ADRs](docs/adr/README.md) | Architecture decision records |

## Design principles

1. **Only inference APIs.** No managed-agent services.
2. **Native features through adapters.** Turned on per agent, never hidden.
3. **Capabilities are declared, not assumed.**
4. **The registry is the source of truth.**
5. **Durable by default.**
6. **Sandboxes are pluggable, E2B by default.**
7. **Library first, platform second.**
8. **Small and readable.**

Each principle is backed by an [ADR](docs/adr/README.md).

## License

The plan proposes Apache-2.0; the choice is still open in [ADR-0016](docs/adr/0016-license.md). A `LICENSE` file will be added once it is accepted.
