# Managed Agents Platform — SDK & Infrastructure Plan

> The project has since been named **Runhive** ([ADR-0015](adr/0015-package-and-install-names.md)): read `agents` imports and packages below as `runhive`, `agents-server` as `runhive-server`, and `AGENTS_*` variables as `RUNHIVE_*`. The plan is otherwise kept as written.

Oct 14, 2026 · @Khushwant

> Source document for this repository. Decisions taken from it are recorded as [ADRs](adr/README.md); the topic docs under [architecture/](architecture/) expand each section.

## Executive summary

Build an open-source, self-hosted managed-agents platform: register an agent once, and the platform hosts it, routes every request to the right agent and version, and runs it on its own harness against Claude or OpenAI models using each model API's native features. Claude Managed Agents and OpenAI's Agents API are reference designs here, not dependencies; the project only calls model inference APIs.

- **Register:** agents are versioned definitions (model, instructions, tools, skills, policies) pushed from code, YAML or the API, with movable aliases such as `prod` and `canary`.
- **Route:** one gateway resolves `name@alias` to a version, splits traffic between versions, picks a model with fallbacks, and lets agents call other agents.
- **Host:** deployments expose agents through HTTP, webhook, cron and queue triggers, with durable sessions that survive worker crashes and stream events over SSE or WebSocket.
- **Run:** the project's own agent loop (tool calling, compaction, subagents, steering, approvals) on thin adapters for the Anthropic Messages API, the OpenAI Responses API and any OpenAI-compatible endpoint.
- **Sandbox:** each session gets an [E2B](https://e2b.dev) sandbox for shell, files and code.

The Python SDK comes first (`from agents import Agent`), the TypeScript SDK second (`import { Agent } from 'agents'`). v0.1 lands in about 8 weeks: registry, router, runtime with both adapters, E2B sandboxes and the Python SDK.

As a portfolio project it shows distributed-systems work (registry, routing, durable execution, multi-tenant hosting) as well as LLM engineering. Scope stays small: Apache-2.0, one polished demo, good docs and a reproducible benchmark.

## Reference designs: Claude Managed Agents and OpenAI Agents API

Neither product is used at runtime; both are studied for their object model and operating lessons. They converged on the same four objects and on separating the harness from the sandbox, and this project copies that shape while owning every layer.

| Dimension | [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) | [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) |
| --- | --- | --- |
| Status | Beta, header `managed-agents-2026-04-01` | Public beta since Sep 10, 2026, header `OpenAI-Beta: agents=v1` |
| Core objects | Agent, Environment, Session, Events | Agent, Environment, Session, Events and items |
| Harness | Anthropic harness with caching and compaction | Open-source Codex harness, run by OpenAI |
| Agent definition | Created once, referenced by ID | Inline on the session or stored and reused |
| Built-in tools | Bash, file ops (read, write, edit, glob, grep), web search and fetch, MCP | Shell, web search, computer use, functions, MCP, plugins, tool search, programmatic tool calling |
| Skills | Agent-level skills, downloaded into the sandbox | `capability_directories` in the sandbox, plus plugins |
| Multi-agent | Subagents | `multi_agent` with `max_concurrent_subagents` |
| Memory | Memory stores mounted at `/mnt/memory/` | Session state and compaction; no separate store named |
| Secrets | Managed credentials | Vaults (`vault_ids`) |
| Self-hosted sandbox | Environment worker polls a work queue (`ant beta:worker poll`); outbound HTTPS only | `codex exec-server` per session over outbound WebSocket |
| Streaming | SSE, full event history fetchable | Stream plus webhooks |
| Scheduling | Scheduled deployments (cron) | Not in the API; webhooks for lifecycle |
| Steering | Send user events mid-run or interrupt | Mid-turn steering |
| Pricing | Tokens plus managed sandbox usage | Tokens plus tool and container rates, no API fee |
| Data limits | Not ZDR or HIPAA BAA eligible | US residency only, not ZDR, even when self-hosted |

**What we borrow:** Agent / Environment / Session / Event objects; agents defined once and referenced by ID; an append-only event stream with steering and interrupt; skills as folders loaded into a sandbox; secrets kept out of model context.

**What we add:** a registry with versions, aliases and traffic splits; routing across models from both vendors in one platform; deployments with HTTP, webhook, cron and queue triggers; and full self-hosting, where session state lives in your Postgres and only model calls leave. Because the harness is ours, a session can even switch between Claude and GPT between runs, which neither managed product allows.

## Design principles, goals and non-goals

The rule is **own the platform, use native model features**: registry, routing, hosting and the agent loop are ours; each model adapter exposes what its API does best instead of a lowest common denominator.

**Principles**

1. **Only inference APIs.** No managed-agent services; the project calls the Messages API, the Responses API or an OpenAI-compatible endpoint.
2. **Native features through adapters.** Prompt caching, adaptive thinking and server tools on Claude; reasoning effort, built-in tools and background mode on OpenAI. Turned on per agent, never hidden.
3. **Capabilities are declared, not assumed.** Each adapter publishes a capability manifest; registration fails if an agent asks for something its model lacks.
4. **The registry is the source of truth.** Everything that runs is a registered, immutable version reached through an alias.
5. **Durable by default.** Every model call and tool call is a checkpointed step, so a crashed worker means a resumed session, not a lost one.
6. **Sandboxes are pluggable, E2B by default,** with Docker for local development.
7. **Library first, platform second.** The same runtime runs embedded in a script and inside hosted deployments.
8. **Small and readable.** A newcomer should understand the core in an afternoon.

**Goals for v1**

- Register, version and alias agents; deploy them behind HTTP, webhook and cron triggers.
- Route by `name@alias`, with weighted traffic splits, session affinity and model fallbacks.
- Own harness: tool loop, streaming, steering, interrupt, compaction, subagents, approvals.
- Adapters for the Anthropic Messages API, the OpenAI Responses API and OpenAI-compatible servers.
- One E2B sandbox per session; sessions survive worker restarts.
- `docker compose up` locally, a Helm chart for Kubernetes, and CI on recorded model responses.

**Non-goals for v1**

- A visual agent builder.
- Training, fine-tuning or hosting model weights (call APIs or OpenAI-compatible servers such as vLLM).
- Billing, payments or a hosted SaaS.

## Architecture overview

Two planes the project owns, plus three things it calls out to: your tools, E2B sandboxes and model APIs.

> Diagram: see [Architecture overview](architecture/overview.md#diagram).

The control plane decides *what* runs (which agent, which version, which deployment); the data plane decides *how* it runs (the loop, tools, sandbox, model). The Postgres run queue between them is what makes sessions durable: any worker can pick up any run from its last checkpoint.

## Core abstractions

Twelve objects in three groups: what is registered, what is hosted, and what runs.

| Group | Object | What it is | Key fields |
| --- | --- | --- | --- |
| Registered | `Agent` | Named definition with an immutable version per change | name, version, model list, instructions, tools, skills, policies |
| Registered | `Alias` | Movable pointer to one or more versions | `prod`, `canary`, version weights |
| Registered | `Tool` | Function (webhook or sandbox script), MCP server, built-in, or another agent | schema, approval policy, secret refs |
| Registered | `Skill` | Versioned folder of instructions and scripts | path, version, description |
| Registered | `Environment` | Sandbox template | provider (`e2b`, `docker`), template, limits |
| Hosted | `Deployment` | An alias made reachable | triggers (http, webhook, cron, queue), concurrency, environment, secrets |
| Hosted | `Secret` | Encrypted credential injected at tool time | name, scope, rotation |
| Runs | `Session` | One conversation or task with its history and sandbox | agent version, status, lease, sandbox id |
| Runs | `Run` | One turn of work started by an input or trigger | steps, usage, stop reason |
| Runs | `Step` | One model call or tool call; the checkpoint unit | type, input, output, status, idempotency key |
| Runs | `Event` | Normalized message on the session stream | seq, type, payload |
| Runs | `Memory` | Files an agent keeps across sessions | store id, path |

**Event schema.** Every event carries `id`, `session_id`, `run_id`, `seq` (monotonic per session), `type`, `ts`, `model` and `payload`. Core types:

- `session.status` (queued, running, waiting\_input, approval\_pending, idle, failed, terminated)
- `route.resolved` (alias, chosen version, chosen model)
- `run.started`, `run.finished` (stop reason, usage)
- `message.user`, `message.agent.delta`, `message.agent.done`, `thinking.delta` (when the model exposes it)
- `tool.call`, `tool.result`, `tool.approval.requested`, `tool.approval.decided`
- `subagent.started`, `subagent.finished`, `artifact.created`, `error`

`seq` lets any client reconnect with `Last-Event-ID` and replay from the log.

## Registration, routing and hosting

This is the heart of the project: a request names an agent, the router resolves it to an exact version and deployment, and the hosting layer runs it durably until it finishes or waits for input.

**Registration**

- `agents apply agent.yaml` or `POST /v1/agents` registers a definition. The registry validates the schema, checks the model's capability manifest, resolves tool and skill references, and stores an immutable version keyed by content hash.
- Re-registering an identical definition is a no-op; any change creates version N+1.
- Aliases (`prod`, `staging`, `canary`) point at versions. Promote = move the pointer; rollback = move it back. Every move is audited.
- Each version publishes an **agent card** (name, description, input schema, skills, endpoint) so other agents and tools can discover it; the card can follow the A2A agent-card format for interoperability.
- Search the registry by name, tag, owner or capability.

**Routing**

| Layer | Decides | How |
| --- | --- | --- |
| Name resolution | `incident-investigator@prod` → version 14 | Alias table cached in memory, invalidated by Postgres NOTIFY |
| Traffic split | 10% of new sessions to v15 | Weighted alias, sticky by hashing the session ID |
| Policy | Which keys may call which agents; rate limits and budgets | Per-project rules checked at the gateway |
| Model routing | Which model serves this run | Agent's ordered model list; next model on 429, 5xx or refusal; tiers such as `fast` and `deep` |
| Agent-to-agent | One agent delegates to or hands off to another | `call_agent` tool resolves through the same router; depth and budget limits; child session linked to parent |
| Session affinity | Follow-up input reaches the session's current worker | Lease row in Postgres; any worker takes over after the lease expires |

**Hosting**

- A **deployment** = alias + triggers + concurrency + environment + secrets. Triggers: HTTP invoke (sync, async or streamed), signed inbound webhooks (GitHub, Slack, Stripe), cron, and queue messages.
- Runtime workers pull runs from a Postgres-backed queue (`FOR UPDATE SKIP LOCKED`) and checkpoint after every step. If a worker dies, its lease expires and another worker resumes from the last completed step.
- Long-lived agents cost nothing while idle: an idle session holds no worker, and its sandbox is paused or snapshotted until the next input.
- Workers scale on queue depth (KEDA on Kubernetes, replica count in Compose); each deployment caps concurrent sessions.
- Lifecycle commands: `deploy`, `promote`, `rollback`, `pause`, `resume`, `delete`.

**Invoking a hosted agent**

```bash
curl -N https://agents.example.com/v1/agents/incident-investigator@prod/invoke \
  -H "Authorization: Bearer $AGENTS_API_KEY" \
  -d '{"input": "5xx spike on service-api", "stream": true}'
```

## Agent runtime: our own harness

The runtime is a step machine: build context, call the model, run the tools it asks for, append the results, and repeat until the model ends its turn, a limit is hit, or it needs input or approval.

- **Loop:** parallel tool calls when the model emits several; per-run limits on steps, tokens and wall-clock; typed stop reasons (`end_turn`, `needs_input`, `approval_pending`, `budget`, `error`).
- **Checkpoints:** each step is written to Postgres before and after execution, with an idempotency key, so a resumed run never repeats a completed tool call.
- **Streaming:** text, thinking and tool progress become events as they arrive.
- **Steering and interrupt:** input sent mid-run is queued and injected at the next step boundary; interrupt cancels the in-flight model call and marks the run.
- **Context management:** native first (Claude's server-side compaction and context editing, OpenAI's compaction); our summarize-and-trim fallback for other models. Prompt order stays cache-friendly: stable system prompt and tools first.
- **Subagents:** a `spawn_subagent` tool starts a child session with its own context and a reduced tool set; its final answer returns as a tool result, with a concurrency cap.
- **Approvals:** tool calls matching a policy pause the run until an approval event arrives.
- **Replay:** every model response is stored per step, so any session can be replayed offline for debugging and tests.

**Core interfaces**

```python
class ModelAdapter(Protocol):
    id: Literal["anthropic", "openai", "openai-compatible"]
    def capabilities(self, model: str) -> CapabilityManifest: ...
    def stream(self, req: ModelRequest) -> AsyncIterator[ModelDelta]: ...  # text, thinking, tool_call, usage

class SandboxProvider(Protocol):
    async def create(self, env: Environment) -> SandboxHandle: ...
    async def exec(self, h: SandboxHandle, cmd: str, timeout: float | None = None) -> ExecResult: ...
    async def write_files(self, h: SandboxHandle, files: list[FileSpec]) -> None: ...
    async def read_files(self, h: SandboxHandle, paths: list[str]) -> list[FileSpec]: ...
    async def pause(self, h: SandboxHandle) -> None: ...      # optional
    async def destroy(self, h: SandboxHandle) -> None: ...

class StepStore(Protocol):  # Postgres in v1; Temporal or Restate could slot in later
    async def begin(self, step: StepSpec) -> StepId: ...
    async def complete(self, step_id: StepId, output: Any) -> None: ...
    async def last_completed(self, run_id: str) -> Step | None: ...
```

## Model adapters and native capabilities

Adapters turn one normalized request (messages, tools, settings) into each vendor's raw API call and stream back normalized deltas. Native features are typed options on the agent, not hidden behind a lowest common denominator.

| Adapter | API | Native features exposed | Notes |
| --- | --- | --- | --- |
| `anthropic` | [Messages API](https://platform.claude.com/docs/en/build-with-claude/overview) | Adaptive thinking and effort, prompt caching (automatic, 5 min, 1 hour), server tools (web search, web fetch, code execution), client tool schemas (bash, text editor, memory, computer use), tool search, programmatic tool calling, compaction and context editing (beta), structured outputs, citations | Most of these are ZDR-eligible; code execution, Files API, Agent Skills and the MCP connector are not, and the adapter flags them |
| `openai` | Responses API | Reasoning effort, built-in tools (web search, file search, code interpreter, shell, computer use, apply patch), remote MCP, tool search, programmatic tool calling, compaction, background mode, prompt caching | The runtime keeps the transcript; response IDs are only a cache optimization |
| `openai-compatible` | Chat Completions style | Tools and streaming | vLLM, Ollama, OpenRouter, other vendors' compatible endpoints |

**Mapping rules**

- **Portable built-ins:** `shell`, `files` and `code` always execute in our E2B sandbox so behavior is identical across models; the adapter presents them with the schema each model was trained on (Claude's bash and text editor tools, OpenAI's shell and apply patch).
- **Web tools:** `web_search` and `web_fetch` use the vendor's server-side tool when present, otherwise our own search-API tool.
- **Reasoning:** `reasoning: 'low' | 'medium' | 'high'` maps to Claude's effort and OpenAI's reasoning effort.
- **Caching:** the Claude adapter places cache breakpoints; the OpenAI adapter relies on automatic prefix caching. The runtime keeps prefixes stable for both.
- **Escape hatch:** `model_options["anthropic"]` and `model_options["openai"]` pass raw fields through, flagged as non-portable.
- **Capability manifest:** static tables plus Claude's Models API `capabilities` object; registration rejects an agent whose features its models can't serve.

**Switching models.** Because the runtime owns the transcript, a session may change model between runs, for example GPT to plan and Claude to execute. Vendor-specific blocks such as thinking signatures are dropped when crossing vendors, and the prompt cache starts cold.

## SDK design

Python ships first and holds the full runtime (`from agents import Agent`); TypeScript follows as the second SDK (`import { Agent } from 'agents'`). One agent definition runs locally in a script, then registers and deploys to your platform unchanged.

**Packages (one monorepo)**

| Order | Package | Contents |
| --- | --- | --- |
| 1 | `agents` (PyPI) | `Agent`, `tool`, `Skill`, the runtime, model adapters, sandbox providers, `Client` and `AsyncClient`; built on asyncio, httpx and Pydantic |
| 1 | `agents-server` (Python) | FastAPI gateway, registry, router, scheduler and runtime workers, reusing the `agents` runtime |
| 1 | `agents-cli` | `agents dev`, `agents apply`, `agents deploy`, `agents promote`, `agents sessions tail` |
| 2 | `agents` (npm) | `Client` and `Agent` definitions generated from the server's OpenAPI spec; local runtime later |
| 3 | `agents-react` | Optional hooks (`useSession`, `useEvents`) |

**Python: define, run locally, register, deploy, invoke**

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

Every call has a sync and an async form (`Client` / `AsyncClient`, `session.events()` / `async for`). Decorated functions run in-process locally; hosted deployments call them as signed webhooks (`url`) or as scripts in the sandbox.

**TypeScript (second SDK)**

```ts
import { Client } from 'agents';

const client = new Client({ baseURL: 'https://agents.example.com' });
const session = await client.invoke('incident-investigator@prod', { input: 'Triage new alerts' });
for await (const ev of session.events()) {
  if (ev.type === 'message.agent.delta') process.stdout.write(ev.text);
}
```

**Server REST surface (v1)**

| Method | Path | Purpose |
| --- | --- | --- |
| POST / GET | `/v1/agents`, `/v1/agents/{name}/versions` | Register and list versions |
| PUT | `/v1/agents/{name}/aliases/{alias}` | Promote, roll back, set traffic weights |
| POST / GET / PATCH | `/v1/deployments` | Create, list, pause deployments and triggers |
| POST | `/v1/agents/{name}@{alias}/invoke` | Start a session through the router (sync, async or streamed) |
| POST | `/v1/hooks/{deployment}` | Inbound signed webhooks |
| POST | `/v1/sessions/{id}/events` | Send input, tool results, approvals |
| GET | `/v1/sessions/{id}/stream`, `/ws` | SSE (resumable) or WebSocket |
| POST | `/v1/sessions/{id}/interrupt` | Stop the current run |
| GET | `/v1/sessions/{id}/events`, `/artifacts` | History and output files |
| POST / GET | `/v1/secrets`, `/v1/environments` | Credentials and sandbox templates |

The server publishes an OpenAPI spec; the TypeScript client and its types are generated from it, so the two SDKs can't drift.

**Developer experience:** agents can live as YAML in a repo, `agents dev` runs gateway, worker and a Docker sandbox locally, and pytest fixtures replay recorded model responses so contributors don't need API keys.

## Infrastructure

Two planes share one Postgres: a control plane (gateway, registry, router, scheduler) and a data plane (runtime workers, tool gateway, sandbox manager). E2B provides the sandboxes, so there is no VM fleet to run.

**Components**

| Component | Plane | Responsibility | v1 shape |
| --- | --- | --- | --- |
| Gateway | Control | TLS, API keys, rate limits, SSE/WebSocket termination | FastAPI behind any ingress |
| Registry | Control | Versions, aliases, deployments, agent cards, validation | Postgres tables + API |
| Router | Control | Alias resolution, traffic split, affinity, enqueue runs | In the gateway process; cached alias table |
| Scheduler | Control | Cron triggers, retries, idle reaper, usage rollup | Postgres advisory locks |
| Stream hub | Control | Fan-out events with `Last-Event-ID` replay | Postgres LISTEN/NOTIFY; Redis Streams at scale |
| Runtime workers | Data | Execute runs step by step; call model adapters; drive tools | Python asyncio workers pulling from the run queue |
| Tool gateway | Data | Webhook tools, MCP client, secret injection, approvals, egress rules | Inside workers in v1 |
| Sandbox manager | Data | Create, pause, resume and destroy sandboxes; file sync; timeouts | E2B SDK; Docker provider for dev |
| Dashboard | — | Agents, versions, deployments, session timelines | Small Next.js app |

**Durable execution.** Runs live in a `runs` table claimed with `FOR UPDATE SKIP LOCKED`; workers heartbeat a lease; each step is a row in `steps` with an idempotency key. Behind a `StepStore` interface, so Temporal or Restate can replace it later without touching agents.

**Sandboxes on E2B**

- One sandbox per session from a template `agents-base` (Ubuntu, bash, Python, Node, git), built from a Dockerfile in the repo.
- Because the harness is ours, workers drive the sandbox through E2B's command and file APIs; nothing agent-specific runs inside it.
- Skills are copied to `/workspace/skills`, inputs to `/workspace/inputs`; `/workspace/outputs` syncs to object storage on `artifact.created` and at idle.
- Idle sessions pause the sandbox where the E2B plan supports it, otherwise snapshot `/workspace` and restore into a new sandbox on the next input.

**Data stores**

- **Postgres:** registry, deployments, sessions, runs, steps, events (partitioned by day), usage, secret metadata.
- **Redis (optional):** alias-cache invalidation, event fan-out and rate limits once there are several gateway replicas.
- **S3-compatible storage (MinIO locally):** artifacts, skill bundles, sandbox snapshots, recorded model responses.
- **Secrets:** AES-GCM envelope encryption with a master key from env or a cloud KMS.

**Request path**

1. Client calls `POST /v1/agents/incident-investigator@prod/invoke`.
2. Gateway authenticates the key and checks project policy and budget.
3. Router resolves the alias (applying any split), creates the session and run, and enqueues it.
4. A worker leases the run, loads the agent version, and creates or resumes the session's sandbox.
5. The loop runs: adapter streams the model, events are appended with `seq` and fanned out to the client, tools execute in the sandbox or tool gateway, and each step is checkpointed.
6. The run ends with a stop reason; after the idle timeout the sandbox is paused.

**Deployment**

- `docker compose up`: gateway, worker, Postgres, MinIO and dashboard.
- Helm chart: gateway Deployment with HPA, worker Deployment scaled by KEDA on queue depth, external or bundled Postgres, Ingress with long read timeouts for SSE.
- GitHub Actions: lint, tests on recorded responses, nightly live tests, PyPI publish (npm once the TypeScript SDK ships) and E2B template build on tags.

## Tools, MCP, skills and memory

Tools run in one of three places: the E2B sandbox, the tool gateway, or the model vendor (server-side tools). The runtime decides where, never the model.

| Type | Executes in | Notes |
| --- | --- | --- |
| Built-in `shell`, `files`, `code` | E2B sandbox, via the E2B SDK | Same behavior for every model; schema matched to each model's native tool |
| Built-in `web_search`, `web_fetch` | Vendor server-side tool, or our search-API tool | Domain allow and block lists |
| Function (webhook) | Tool gateway → your HTTPS endpoint | HMAC-signed, retried, idempotency key per call |
| Function (sandbox script) | E2B sandbox | Code shipped with the agent version |
| MCP server | Tool gateway acting as MCP client | Secrets injected; tools listed at run start; tool search when there are many |
| `call_agent` | Router | Starts or resumes another registered agent and returns its output |

**Approvals.** Each tool carries `approval: never | always | { when: <expr> }`. A matching call pauses the run (`approval_pending`), emits `tool.approval.requested`, and resumes on an approval event. Same flow for every model.

**Secrets.** Stored encrypted, referenced by name, injected by the tool gateway at call time. They never enter model context or the sandbox's environment.

**Skills.** A skill is a versioned folder (`SKILL.md` plus scripts) registered like an agent. At session start it is copied to `/workspace/skills/<name>`; the runtime lists each skill's name and description in the system prompt, and the model opens `SKILL.md` only when it needs it. This progressive loading works on any model.

**Memory.**

- **Within a session:** handled by the runtime's context management (native compaction where available).
- **Across sessions:** a per-agent memory store synced as files into `/workspace/memory`; on Claude the adapter exposes it through the native memory tool schema, with storage implemented by us.

## Security, multi-tenancy, observability and cost

Sandboxes are the untrusted zone: model provider keys and secrets stay in the control and data planes and never reach agent-written code or model context.

**Security and tenancy**

- **Trust zones:** gateway and workers are trusted; sandboxes run untrusted agent code; tool results are untrusted input to the model.
- **Provider keys:** bring-your-own Anthropic and OpenAI keys per project, encrypted, used only by workers.
- **Sandbox isolation:** one E2B sandbox (a Firecracker microVM) per session, never shared across tenants, with a hard timeout, no platform credentials, and network access restricted where the provider allows it.
- **Tenant model:** `org → project → API key`, RBAC roles (admin, developer, viewer), and per-project allowlists for models, tools, egress domains and which agents may call which.
- **Prompt-injection hygiene:** approvals on high-risk tools, egress allowlists, and a depth limit on `call_agent` chains.
- **Data posture:** sessions, transcripts and files live in your Postgres and storage; only model calls leave. With ZDR-eligible features and accounts, vendors retain nothing; the adapter flags features that are not ZDR-eligible.
- **Audit log:** registrations, alias moves, deployments, sessions, tool calls, approvals and secret reads.

**Observability**

- OpenTelemetry traces with a span per run, step and tool call, using the GenAI semantic conventions; agent version and resolved route on every span.
- Prometheus metrics: queue depth, time to first token, run latency, tool error rate, provider 429 and 5xx rates, cache hit rate, cost per run, sessions resumed after worker failure.
- A session timeline and replay viewer in the dashboard, built from the event log and recorded responses.

**Cost controls**

- Usage recorded per step: input, output and cached tokens per model, sandbox seconds, tool calls.
- Budgets per project, deployment and session; max steps and wall-clock per run; automatic stop with a `budget` stop reason.
- Model tiers and fallbacks let cheap models take easy runs.
- No billing in core; usage is exposed through the API and Prometheus for anyone who wants to charge on top.

## Roadmap, risks and open questions

Ship v0.1 with the Python SDK in about eight weeks; each phase ends on a gate that proves the riskiest assumption first.

> Phases and gates: see [Roadmap](roadmap.md#phases-and-gates).

After v0.1 (weeks 9 to 12): the TypeScript SDK, the dashboard, the Helm chart with KEDA autoscaling, subagents, and OpenTelemetry dashboards.

**What makes it resume-ready:** a README GIF of an agent being registered, deployed and invoked by `name@alias`; a chaos demo that kills a worker mid-run and shows the session resume; a benchmark of the same task on Claude and GPT (time, tokens, cost); 80%+ test coverage on the runtime; and a short design write-up.

**Risks**

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Model APIs differ and change (thinking blocks, tool formats, caching rules) | Adapter bugs, broken sessions | Contract tests on recorded responses per adapter; nightly live tests; pinned vendor SDKs |
| Durable execution is subtle (double tool calls, stuck leases) | Lost or duplicated work | Idempotency keys, lease heartbeats, a CI chaos test that kills workers |
| The `agents` name is already used: npm `agents` is Cloudflare's Agents SDK, and the Python module `agents` is what OpenAI's Agents SDK installs | Install conflicts, confused users | Decide install names before v0.1 (see open questions) |
| E2B costs and limits on long sessions | Surprise bills, killed sessions | Hard timeouts, pause or snapshot when idle, Docker provider for dev |
| Registry, router, runtime and hosting is a lot for one person | Nothing ships | Hold the non-goals; dashboard and TypeScript SDK only after v0.1 |

**Open questions**

- [ ] Install names: keep the `agents` import but publish as distinct packages (for example a scoped npm package and a different PyPI name), or pick a fresh namespace?
- [ ] License: Apache-2.0 (patent grant) or MIT (simplest)?
- [ ] Durable execution: plain Postgres queue in v0.1, or adopt Temporal or Restate from day one?
- [ ] Flagship demo: incident investigator or a GitHub issue fixer?

**Sources**

- [Claude Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)
- [Claude Managed Agents: self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
- [OpenAI: Introducing the Agents API](https://openai.com/index/introducing-the-agents-api/)
- [OpenAI Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview)
- [OpenAI Agents API: self-hosted sandboxes](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)
- [RuntimeWire: OpenAI managed agents and Agent Builder wind-down](https://runtimewire.com/article/openai-managed-agents-devday-2026)
- [Claude features overview (Messages API)](https://platform.claude.com/docs/en/build-with-claude/overview)
