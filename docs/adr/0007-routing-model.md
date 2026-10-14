# ADR-0007: Routing: `name@alias`, sticky weighted splits, model fallbacks

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Registration, routing and hosting](../architecture/registry-routing-hosting.md#routing), ADR-0004

## Context

A request names an agent; the platform must turn that into an exact version, a model, and a worker, while supporting canaries, vendor outages, policy and agent-to-agent calls. Routing decisions need to be fast (on every request) and consistent (a session must not flip versions mid-conversation).

## Decision

One router, running in the gateway process, resolves every request in layers:

| Layer | Decision | Mechanism |
| --- | --- | --- |
| Name resolution | `incident-investigator@prod` → version 14 | Alias table cached in memory, invalidated by Postgres `NOTIFY` |
| Traffic split | e.g. 10% of new sessions to v15 | Weighted alias, sticky by hashing the session ID |
| Policy | Which keys may call which agents; rate limits, budgets | Per-project rules checked at the gateway |
| Model routing | Which model serves this run | Agent's ordered model list; next model on 429, 5xx or refusal; tiers such as `fast` and `deep` |
| Agent-to-agent | Delegation or handoff | `call_agent` tool resolves through the same router; depth and budget limits; child session linked to parent |
| Session affinity | Follow-up input reaches the session's current worker | Lease row in Postgres; any worker takes over after the lease expires |

Splits apply to **new sessions**; an existing session keeps its version. Every resolution emits a `route.resolved` event (alias, chosen version, chosen model).

## Alternatives considered

- **Per-request random split.** Breaks multi-turn sessions across versions.
- **Separate router service.** An extra hop and deployment for no v1 benefit; it can be split out later.
- **Service-mesh routing.** Works at the HTTP layer, but cannot see aliases, sessions or model fallbacks.

## Consequences

- `call_agent` gets the same policy, splits and audit as external callers.
- With several gateway replicas, alias-cache invalidation may move to Redis.
- Cross-vendor fallback relies on the runtime owning the transcript (ADR-0011).
