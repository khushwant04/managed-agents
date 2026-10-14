# Architecture overview

Two planes the project owns, plus three things it calls out to: your tools, E2B sandboxes and model APIs.

- The **control plane** decides *what* runs: which agent, which version, which deployment.
- The **data plane** decides *how* it runs: the loop, tools, sandbox, model.
- The **Postgres run queue** between them is what makes sessions durable: any worker can pick up any run from its last checkpoint ([ADR-0005](../adr/0005-durable-execution-on-postgres.md)).

## Diagram

```mermaid
flowchart LR
    client["Clients<br/>SDK · CLI · curl · webhooks"]

    subgraph control["Control plane"]
        gateway["Gateway<br/>TLS · API keys · rate limits · SSE/WS"]
        router["Router<br/>alias · split · policy · affinity"]
        registry["Registry<br/>versions · aliases · deployments · cards"]
        scheduler["Scheduler<br/>cron · retries · idle reaper"]
        hub["Stream hub<br/>fan-out · Last-Event-ID replay"]
    end

    pg[("Postgres<br/>registry · runs queue · steps · events")]
    s3[("S3 / MinIO<br/>artifacts · skills · snapshots")]

    subgraph data["Data plane"]
        worker["Runtime workers<br/>agent loop · checkpoints"]
        adapters["Model adapters<br/>anthropic · openai · openai-compatible"]
        toolgw["Tool gateway<br/>webhooks · MCP · secrets · approvals"]
        sbm["Sandbox manager<br/>create · pause · destroy · sync"]
    end

    subgraph ext["External services"]
        models["Model APIs<br/>Messages · Responses · compatible"]
        tools["Your tools<br/>HTTPS webhooks · MCP servers"]
        e2b["E2B sandboxes<br/>one per session"]
    end

    client --> gateway
    gateway --> router
    router --> registry
    registry --- pg
    router -- enqueue run --> pg
    scheduler -- cron runs --> pg
    pg -- "claim (SKIP LOCKED)" --> worker
    worker -- events --> pg
    pg -- NOTIFY --> hub
    hub -- stream --> gateway
    worker --> adapters --> models
    worker --> toolgw --> tools
    worker --> sbm --> e2b
    sbm --- s3
```

## Components

| Component | Plane | Responsibility |
| --- | --- | --- |
| Gateway | Control | TLS, API keys, rate limits, SSE/WebSocket termination |
| Registry | Control | Versions, aliases, deployments, agent cards, validation |
| Router | Control | Alias resolution, traffic split, affinity, enqueue runs |
| Scheduler | Control | Cron triggers, retries, idle reaper, usage rollup |
| Stream hub | Control | Fan-out events with `Last-Event-ID` replay |
| Runtime workers | Data | Execute runs step by step; call model adapters; drive tools |
| Tool gateway | Data | Webhook tools, MCP client, secret injection, approvals, egress rules |
| Sandbox manager | Data | Create, pause, resume and destroy sandboxes; file sync; timeouts |
| Dashboard | — | Agents, versions, deployments, session timelines |

Details and v1 shapes: [Infrastructure](infrastructure.md).

## Request path

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant G as Gateway + Router
    participant P as Postgres
    participant W as Worker
    participant M as Model API
    participant S as E2B sandbox

    C->>G: POST /v1/agents/incident-investigator@prod/invoke
    G->>G: authenticate key, check policy and budget
    G->>P: resolve alias (apply split), create session + run, enqueue
    G-->>C: SSE stream opens (route.resolved, session.status)
    W->>P: lease run (FOR UPDATE SKIP LOCKED)
    W->>S: create or resume session sandbox
    loop until end_turn, limit, needs_input or approval
        W->>M: adapter streams model call
        W->>P: append events (seq), checkpoint step
        P-->>C: fan-out via stream hub
        W->>S: run tool calls (shell, files, code)
        W->>P: checkpoint tool step
    end
    W->>P: run.finished (stop reason, usage)
    Note over W,S: after idle timeout the sandbox is paused
```

1. Client calls `POST /v1/agents/incident-investigator@prod/invoke`.
2. Gateway authenticates the key and checks project policy and budget.
3. Router resolves the alias (applying any split), creates the session and run, and enqueues it.
4. A worker leases the run, loads the agent version, and creates or resumes the session's sandbox.
5. The loop runs: the adapter streams the model, events are appended with `seq` and fanned out to the client, tools execute in the sandbox or tool gateway, and each step is checkpointed.
6. The run ends with a stop reason; after the idle timeout the sandbox is paused.

## Where to go next

- [Core abstractions](core-abstractions.md): the objects that flow through this picture.
- [Registration, routing and hosting](registry-routing-hosting.md): the control plane in depth.
- [Agent runtime](runtime.md): the data plane's loop.
