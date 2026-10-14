# ADR-0018: Durable resume by deterministic replay of keyed steps

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** ADR-0005, ADR-0008, [Agent runtime](../architecture/runtime.md)

## Context

ADR-0005 puts every model call and tool call in a `steps` table behind `StepStore`, but leaves open how a worker that takes over a run rebuilds its state, and where the session transcript lives. A second copy of the transcript (for example a JSON column on the session) can drift from the steps after a crash between the two writes.

## Decision

- Each step has a key that is **deterministic within its run**: `input:0`, `steer:<n>`, `compact:<n>`, `model:<n>`, `tool:<call id>`, `approval:<call id>`. `begin` on an existing key returns the same row and counts an attempt; a completed step is never re-run.
- A run is a pure function of its input and its completed steps. Resuming a run **replays** it: the runner walks the same loop and, at each step, uses the stored output when the step is completed, executing only from the first incomplete step on. Replayed steps emit no events.
- The **transcript is derived** from completed steps (inputs, model messages, tool results, compactions) across the session's runs, in step order. There is no separate copy.
- A tool step that began but did not complete is retried with the same idempotency key (`<run id>:tool:<call id>`), which webhook receivers use to deduplicate.

## Alternatives considered

- **Event sourcing from the event log.** Events are for clients (deltas, statuses) and include non-deterministic streaming detail; steps are the right granularity.
- **Snapshotting the transcript per step.** Simple reads, but quadratic storage on long sessions and a second source of truth.

## Consequences

- Approvals are steps too, so a run waiting for approval resumes on any worker by replay.
- The chaos test (`test_worker_killed_mid_run_is_resumed_by_another`) checks the guarantee end to end.
- Model calls interrupted mid-stream are re-run on resume; clients may see a partial delta stream followed by a fresh one (the `session.status` event carries `resumed: true`).
