# ADR-0014: Tool approvals as declarative policy that pauses the run

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Tools, skills and memory](../architecture/tools-skills-memory.md#approvals), ADR-0005, ADR-0008

## Context

Some tool calls are high-risk (deploys, deletes, payments, external messages), and tool results are untrusted input that can carry prompt injection. Humans need to approve such calls without a worker sitting blocked, and the flow must be identical on every model.

## Decision

Each tool carries an approval policy: `approval: never | always | { when: <expr> }`. When a call matches:

1. The run pauses with stop reason `approval_pending` and session status `approval_pending`.
2. The runtime emits `tool.approval.requested`.
3. The step is checkpointed, and the worker releases the run (an idle session holds no worker).
4. An approval event (`POST /v1/sessions/{id}/events`) emits `tool.approval.decided` and re-enqueues the run, which resumes from the checkpoint.

## Alternatives considered

- **Vendor-side approval features.** Differ per vendor and don't cover our own tools.
- **Blocking the worker while waiting.** Simple but wastes capacity and breaks on worker restarts.

## Consequences

- The `when` expression language needs to be small and safe to evaluate; its exact syntax is still to be specified.
- Approvals appear in the audit log and the session timeline.
