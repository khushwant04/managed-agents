# ADR-0005: Durable execution on a Postgres run queue behind `StepStore`

- **Status:** Proposed
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Agent runtime](../architecture/runtime.md), [Infrastructure](../architecture/infrastructure.md), [open questions](../roadmap.md#open-questions)

## Context

Principle 5 is "durable by default": a crashed worker must mean a resumed session, not a lost one, and a resumed run must never repeat a completed tool call. The plan leaves open whether v0.1 should use a plain Postgres queue or adopt Temporal or Restate from day one.

## Decision (recommended)

We will implement durable execution on Postgres for v0.1, behind a `StepStore` interface so a workflow engine can replace it later without touching agents.

- Runs live in a `runs` table, claimed by workers with `SELECT ... FOR UPDATE SKIP LOCKED`.
- A claiming worker holds a **lease** and heartbeats it. When the lease expires, any worker may take over the run.
- Every model call and tool call is a row in `steps`, written before and after execution, with an **idempotency key**. On resume, the worker continues after `last_completed`, and tool calls reuse their idempotency key so webhooks can deduplicate.
- Every model response is stored per step, enabling offline replay.

```python
class StepStore(Protocol):  # Postgres in v1; Temporal or Restate could slot in later
    async def begin(self, step: StepSpec) -> StepId: ...
    async def complete(self, step_id: StepId, output: Any) -> None: ...
    async def last_completed(self, run_id: str) -> Step | None: ...
```

## Alternatives considered

- **Temporal from day one.** Battle-tested semantics, but adds a cluster to run, a second programming model and heavier `docker compose up`; hides the distributed-systems work the project is meant to show.
- **Restate.** Lighter than Temporal, same concern about an extra dependency for v0.1.
- **Redis queue.** Fast, but splits state across two stores and weakens transactional checkpoints.

## Consequences

- One store for registry, queue, steps and events keeps local setup to Postgres plus MinIO.
- We own subtle failure modes (double tool calls, stuck leases); mitigated by idempotency keys, lease heartbeats and a CI chaos test that kills workers mid-run.
- Throughput is bounded by Postgres; acceptable for v1 and swappable later via `StepStore`.

## To decide

Accept Postgres for v0.1 (recommended), or adopt Temporal/Restate now.
