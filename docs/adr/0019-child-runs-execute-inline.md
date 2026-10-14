# ADR-0019: Child runs from call_agent and spawn_subagent execute inline

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** ADR-0005, ADR-0007, [Agent runtime](../architecture/runtime.md)

## Context

`call_agent` and `spawn_subagent` start a child session and wait for its answer as a tool result. If the child run went through the queue like any other run, a worker whose slots are all held by waiting parents could never pick up the children: a deadlock under load.

## Decision

The parent's worker creates the child session and run through the normal path (router, policy, depth and budget checks, `parent_session_id`, its own events and steps), then **claims that specific run and executes it inline**, in the same task that is executing the parent's tool call. The child needs no extra worker slot.

- `spawn_subagent` children run the parent's agent version with a reduced tool set and share the parent's sandbox (`metadata.share_sandbox_of`).
- `call_agent` children resolve the target through the router like any external call.
- If the parent's worker dies, the parent's tool step is incomplete and the child's run has an expired lease; on resume, the replayed parent re-issues the call and the child run is resumed or completed by whichever worker claims it.

## Consequences

- No slot deadlocks; nested depth is bounded by `max_call_depth` and the subagent policy's `max_depth`.
- A slow child holds its parent's slot for its duration, which is the cost already paid by the parent waiting.
