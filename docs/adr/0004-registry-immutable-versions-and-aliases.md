# ADR-0004: Registry of immutable, content-hashed versions with movable aliases

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Registration, routing and hosting](../architecture/registry-routing-hosting.md), ADR-0007

## Context

Agents change often (instructions, tools, models). Running sessions, traffic splits, rollbacks, audits and replay all need to know exactly which definition produced a given result. If a definition can be edited in place, none of those are trustworthy.

## Decision

The registry is the source of truth: everything that runs is a registered, immutable version reached through an alias.

- `runhive apply agent.yaml` or `POST /v1/agents` registers a definition. The registry validates the schema, checks capability manifests (ADR-0003), resolves tool and skill references, and stores an immutable version **keyed by content hash**.
- Re-registering an identical definition is a no-op; any change creates version N+1.
- **Aliases** (`prod`, `staging`, `canary`) point at one or more versions, optionally with weights. Promote moves the pointer; rollback moves it back. Every move is audited.
- Each version publishes an **agent card** (name, description, input schema, skills, endpoint), which can follow the A2A agent-card format for interoperability.
- Skills are registered and versioned the same way (ADR-0013).

## Alternatives considered

- **Mutable agents with history.** Simpler API, but "what ran" becomes a timestamp lookup and splits between versions become awkward.
- **Git as the registry.** Good for YAML-in-repo users, but excludes API and SDK registration; YAML-in-repo remains supported through `runhive apply`.

## Consequences

- Rollback is instant and safe: no rebuild, just a pointer move.
- Sessions record the exact version they run, which makes replay and debugging deterministic.
- Versions accumulate; a retention policy for unreferenced versions will be needed eventually.
