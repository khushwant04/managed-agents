# Server REST API (v1)

The server publishes an OpenAPI spec, checked in at [openapi.json](openapi.json) and regenerated with `runhive-server openapi`; the TypeScript client and its types are generated from it ([ADR-0012](../adr/0012-python-first-typescript-generated.md)). All requests authenticate with `Authorization: Bearer $RUNHIVE_API_KEY`, scoped to a project. Roles: `viewer` (read), `developer` (register, deploy, invoke, steer), `admin` (secrets, keys, policy, audit).

## Endpoints

| Method | Path | Purpose | Role |
| --- | --- | --- | --- |
| POST | `/v1/agents` | Register a definition; identical definitions return the existing version (200) | developer |
| GET | `/v1/agents?q=&tag=&owner=&capability=` | Search the registry | viewer |
| GET | `/v1/agents/{name}/versions`, `/v1/agents/{name}/versions/{v}` | List versions; one version's spec and card | viewer |
| GET | `/v1/agents/{name}@{alias}/card` | Agent card (A2A shape) | viewer |
| GET / PUT | `/v1/agents/{name}/aliases`, `/v1/agents/{name}/aliases/{alias}` | List aliases; promote or set weights | viewer / developer |
| POST | `/v1/agents/{name}/aliases/{alias}/rollback` | Move an alias back to its previous target | developer |
| POST | `/v1/agents/{name}@{alias}/invoke` | Start a session through the router (`mode`: `sync`, `async`, `stream`) | developer |
| POST / GET / PATCH / DELETE | `/v1/deployments`, `/v1/deployments/{ref}` | Create, list, update (pause, triggers, version), delete | developer |
| POST | `/v1/deployments/{ref}/invoke` | HTTP trigger (with the deployment's concurrency cap) | developer |
| POST | `/v1/hooks/{deployment}` | Inbound signed webhooks: GitHub, Slack, Stripe, generic | signature |
| POST | `/v1/queues/{name}/messages` | Queue trigger: start a session on every deployment listening on `name` | developer |
| GET | `/v1/sessions`, `/v1/sessions/{id}` | List sessions; one session with its active and last run | viewer |
| POST | `/v1/sessions/{id}/events` | Send input (`message.user`) or decide approvals (`tool.approval.decided`) | developer |
| GET | `/v1/sessions/{id}/events?after=` | Event history | viewer |
| GET | `/v1/sessions/{id}/stream`, `/v1/sessions/{id}/ws` | SSE (resumable with `Last-Event-ID`) or WebSocket | viewer |
| POST | `/v1/sessions/{id}/interrupt` | Stop the current run | developer |
| DELETE | `/v1/sessions/{id}` | Terminate the session | developer |
| GET | `/v1/sessions/{id}/artifacts`, `/v1/sessions/{id}/artifacts/{aid}` | Output files and downloads | viewer |
| POST / GET / DELETE | `/v1/secrets`, `/v1/secrets/{name}` | Encrypted credentials (values are never returned) | admin / viewer |
| POST / GET | `/v1/environments` | Sandbox templates | developer / viewer |
| POST / GET | `/v1/skills` | Upload a skill bundle (`.tar.gz` with `SKILL.md`); list skills | developer / viewer |
| GET / PUT | `/v1/project`, `/v1/project/policy` | Project info; allowlists, budgets, egress domains | viewer / admin |
| POST / DELETE | `/v1/keys`, `/v1/keys/{id}` | Create and revoke API keys | admin |
| GET | `/v1/usage?days=`, `/v1/audit` | Usage per day and model; audit log | viewer / admin |
| GET | `/healthz`, `/readyz`, `/metrics` | Health, readiness, Prometheus metrics | none |

Errors are JSON: `{"error": "<code>", "message": "..."}`; a rejected agent definition returns 422 with `problems`, a list of every reason.

## Invoke

```bash
curl -N https://runhive.example.com/v1/agents/incident-investigator@prod/invoke \
  -H "Authorization: Bearer $RUNHIVE_API_KEY" \
  -d '{"input": "5xx spike on service-api", "stream": true}'
```

- **Sync** (default): waits for the run to finish and returns `session_id`, `run_id`, the resolved `version`, `status`, `stop_reason`, `output` and `usage`.
- **Async** (`"mode": "async"`): returns 202 with the session and run IDs; follow with `/stream` or `/events`.
- **Stream** (`"stream": true` or `"mode": "stream"`): an SSE stream of [events](../architecture/core-abstractions.md#event-schema) that ends when the run settles.

## Streaming and reconnect

`GET /v1/sessions/{id}/stream` is a Server-Sent Events stream. Each SSE `id` is the event's `seq`. On reconnect, send `Last-Event-ID: <seq>` and the server replays every later event from the log before going live ([ADR-0008](../adr/0008-event-log-and-streaming.md)). With `until_settled=true` the stream ends once the current run settles. Comments (`: keepalive`) are sent every 15 seconds.

```text
id: 41
event: message.agent.delta
data: {"seq":41,"type":"message.agent.delta","payload":{"text":"Checking recent deploys"}, ...}
```

The WebSocket at `/v1/sessions/{id}/ws` (key in the `Authorization` header or `?token=`) sends the same events as JSON text frames and accepts `{"type": "message.user", "text": ...}` and `{"type": "tool.approval.decided", "call_id": ..., "approved": true}`.

## Webhooks

`POST /v1/hooks/{deployment}` accepts a webhook when it matches a `webhook` trigger's provider signature, using the deployment's webhook secret (returned once, when the deployment is created):

| Provider | Signature |
| --- | --- |
| `github` | `X-Hub-Signature-256: sha256=HMAC(secret, body)` |
| `slack` | `X-Slack-Signature: v0=HMAC(secret, "v0:{ts}:{body}")`, `X-Slack-Request-Timestamp` (5 minute window); answers `url_verification` |
| `stripe` | `Stripe-Signature: t={ts},v1=HMAC(secret, "{ts}.{body}")` |
| `generic` | `X-Runhive-Signature: t={ts},v1=HMAC(secret, "{ts}.{body}")` |

The trigger's `input` template builds the session input from the payload: `{body}`, `{event}` and dotted paths such as `{issue.title}`.

Tool webhooks (function tools with a `url`) are signed the same way as `generic` and carry `Idempotency-Key`; receivers verify them with `runhive.tools.webhook.verify`.
