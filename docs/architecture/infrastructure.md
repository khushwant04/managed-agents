# Infrastructure

Two planes share one Postgres: a control plane (gateway, registry, router, scheduler) and a data plane (runtime workers, tool gateway, sandbox manager). E2B provides the sandboxes, so there is no VM fleet to run. See the [overview diagram](overview.md#diagram).

## Components

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

## Durable execution

Runs live in a `runs` table claimed with `FOR UPDATE SKIP LOCKED`; workers heartbeat a lease; each step is a row in `steps` with an idempotency key. Behind a `StepStore` interface, so Temporal or Restate can replace it later without touching agents ([ADR-0005](../adr/0005-durable-execution-on-postgres.md)).

Sketch of the claim query (illustrative):

```sql
UPDATE runs SET worker_id = $1, lease_until = now() + interval '30 seconds', status = 'running'
WHERE id = (
  SELECT id FROM runs
  WHERE status = 'queued' OR (status = 'running' AND lease_until < now())
  ORDER BY enqueued_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

## Sandboxes on E2B

Decision record: [ADR-0006](../adr/0006-e2b-sandbox-per-session.md).

- One sandbox per session from a template `runhive-base` (Ubuntu, bash, Python, Node, git), built from a Dockerfile in the repo.
- Because the harness is ours, workers drive the sandbox through E2B's command and file APIs; nothing agent-specific runs inside it.
- Skills are copied to `/workspace/skills`, inputs to `/workspace/inputs`; `/workspace/outputs` syncs to object storage on `artifact.created` and at idle.
- Idle sessions pause the sandbox where the E2B plan supports it, otherwise snapshot `/workspace` and restore into a new sandbox on the next input.
- E2B Cloud or self-hosted: the same provider works against a self-hosted E2B runtime such as [E2B Embed](https://github.com/e2b-dev/runtime) through `E2B_API_URL` and `E2B_SANDBOX_URL`. `runhive e2b check` verifies a setup end to end, and the `e2b-embed` CI workflow runs that check against a real Embed install ([infra/e2b](../../infra/e2b/README.md#checking-a-setup)).

```text
/workspace
├── inputs/     # files provided with the input
├── outputs/    # synced to object storage → artifacts
├── skills/     # one folder per skill
└── memory/     # per-agent memory store
```

## Data stores

- **Postgres:** registry, deployments, sessions, runs, steps, events (partitioned by day), usage, secret metadata.
- **Redis (optional):** alias-cache invalidation, event fan-out and rate limits once there are several gateway replicas.
- **S3-compatible storage (MinIO locally):** artifacts, skill bundles, sandbox snapshots, recorded model responses.
- **Secrets:** AES-GCM envelope encryption with a master key from env or a cloud KMS ([ADR-0010](../adr/0010-secrets-handling.md)).

## Deployment

- **Local:** `docker compose up` starts gateway, worker, Postgres, MinIO and dashboard. `runhive dev` runs gateway, worker and a Docker sandbox locally.
- **Kubernetes (Helm chart):** gateway Deployment with HPA; worker Deployment scaled by KEDA on queue depth; external or bundled Postgres; Ingress with long read timeouts for SSE.
- **CI (GitHub Actions):** lint, tests on recorded responses, nightly live tests, PyPI publish (npm once the TypeScript SDK ships) and E2B template build on tags.
