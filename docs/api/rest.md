# Server REST API (v1)

The server publishes an OpenAPI spec; the TypeScript client and its types are generated from it ([ADR-0012](../adr/0012-python-first-typescript-generated.md)). All requests authenticate with `Authorization: Bearer $AGENTS_API_KEY`, scoped to a project.

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

## Invoke

```bash
curl -N https://agents.example.com/v1/agents/incident-investigator@prod/invoke \
  -H "Authorization: Bearer $AGENTS_API_KEY" \
  -d '{"input": "5xx spike on service-api", "stream": true}'
```

- **Sync:** waits for the run to finish and returns the final output.
- **Async:** returns the session ID immediately; follow with `/stream` or `/events`.
- **Streamed:** returns an SSE stream of [events](../architecture/core-abstractions.md#event-schema).

## Streaming and reconnect

`GET /v1/sessions/{id}/stream` is a Server-Sent Events stream. Each SSE `id` is the event's `seq`. On reconnect, send `Last-Event-ID: <seq>` and the server replays every later event from the log before going live ([ADR-0008](../adr/0008-event-log-and-streaming.md)).

```text
id: 41
event: message.agent.delta
data: {"seq":41,"type":"message.agent.delta","payload":{"text":"Checking recent deploys"}}
```

## Request and response bodies

Bodies are defined by the OpenAPI spec published with v0.1. Examples in these docs are illustrative.
