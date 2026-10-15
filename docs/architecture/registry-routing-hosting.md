# Registration, routing and hosting

This is the heart of the project: a request names an agent, the router resolves it to an exact version and deployment, and the hosting layer runs it durably until it finishes or waits for input.

## Registration

Decision record: [ADR-0004](../adr/0004-registry-immutable-versions-and-aliases.md).

- `runhive apply agent.yaml` or `POST /v1/agents` registers a definition. The registry:
  1. validates the schema,
  2. checks each model's capability manifest ([ADR-0003](../adr/0003-native-features-through-adapters.md)),
  3. resolves tool and skill references,
  4. stores an immutable version keyed by content hash.
- Re-registering an identical definition is a no-op; any change creates version N+1.
- Aliases (`prod`, `staging`, `canary`) point at versions. Promote = move the pointer; rollback = move it back. Every move is audited.
- Each version publishes an **agent card** (name, description, input schema, skills, endpoint) so other agents and tools can discover it; the card can follow the A2A agent-card format for interoperability.
- Search the registry by name, tag, owner or capability.

Example `agent.yaml` (illustrative; the schema is defined with the SDK):

```yaml
name: incident-investigator
model: [claude-opus-5-5, gpt-6-astra]   # primary, then fallback
reasoning: high
instructions: |
  Investigate alerts. Write findings to /workspace/outputs/report.md.
tools:
  - shell
  - files
  - web_search
  - mcp: https://obs.example.com/mcp
    secret: OBS_TOKEN
  - name: lookup_deploys
    url: https://internal.example.com/tools/deploys
    approval: never
skills: [./skills/runbooks]
subagents: { max_concurrent: 3 }
model_options:
  anthropic: { cache: 1h }
```

## Routing

Decision record: [ADR-0007](../adr/0007-routing-model.md).

| Layer | Decides | How |
| --- | --- | --- |
| Name resolution | `incident-investigator@prod` → version 14 | Alias table cached in memory, invalidated by Postgres `NOTIFY` |
| Traffic split | 10% of new sessions to v15 | Weighted alias, sticky by hashing the session ID |
| Policy | Which keys may call which agents; rate limits and budgets | Per-project rules checked at the gateway |
| Model routing | Which model serves this run | Agent's ordered model list; next model on 429, 5xx or refusal; tiers such as `fast` and `deep` |
| Agent-to-agent | One agent delegates to or hands off to another | `call_agent` tool resolves through the same router; depth and budget limits; child session linked to parent |
| Session affinity | Follow-up input reaches the session's current worker | Lease row in Postgres; any worker takes over after the lease expires |

Setting a split:

```bash
curl -X PUT https://runhive.example.com/v1/agents/incident-investigator/aliases/prod \
  -H "Authorization: Bearer $RUNHIVE_API_KEY" \
  -d '{"versions": [{"version": 14, "weight": 90}, {"version": 15, "weight": 10}]}'
```

## Hosting

- A **deployment** = alias + triggers + concurrency + environment + secrets.
- **Triggers:**
  - HTTP invoke: sync, async or streamed.
  - Signed inbound webhooks (GitHub, Slack, Stripe) at `/v1/hooks/{deployment}`.
  - Cron, run by the scheduler.
  - Queue messages.
- Runtime workers pull runs from a Postgres-backed queue (`FOR UPDATE SKIP LOCKED`) and checkpoint after every step. If a worker dies, its lease expires and another worker resumes from the last completed step ([ADR-0005](../adr/0005-durable-execution-on-postgres.md)).
- Long-lived agents cost nothing while idle: an idle session holds no worker, and its sandbox is paused or snapshotted until the next input.
- Workers scale on queue depth (KEDA on Kubernetes, replica count in Compose); each deployment caps concurrent sessions.
- Lifecycle commands: `deploy`, `promote`, `rollback`, `pause`, `resume`, `delete`.

## Invoking a hosted agent

```bash
curl -N https://runhive.example.com/v1/agents/incident-investigator@prod/invoke \
  -H "Authorization: Bearer $RUNHIVE_API_KEY" \
  -d '{"input": "5xx spike on service-api", "stream": true}'
```

See the [REST API](../api/rest.md) for the full surface.
