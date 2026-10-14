# ADR-0008: Append-only session event log with resumable streaming

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Core abstractions](../architecture/core-abstractions.md#event-schema), [REST API](../api/rest.md)

## Context

Clients need live output (text, thinking, tool progress), must be able to reconnect without losing anything, and must be able to send input mid-run. Local runs and hosted runs should look identical to client code. Both reference designs use an append-only event stream with steering and interrupt.

## Decision

Every session has an append-only **event log** in Postgres. Each event carries `id`, `session_id`, `run_id`, `seq` (monotonic per session), `type`, `ts`, `model` and `payload`. Types are normalized across vendors (`session.status`, `route.resolved`, `run.*`, `message.*`, `thinking.delta`, `tool.*`, `subagent.*`, `artifact.created`, `error`).

- Clients stream over **SSE** (`/v1/sessions/{id}/stream`) or **WebSocket** (`/ws`). SSE reconnects with `Last-Event-ID` and replays from the log by `seq`.
- Fan-out uses Postgres `LISTEN/NOTIFY` in v1; Redis Streams at scale.
- Input, tool results and approvals are sent as events (`POST /v1/sessions/{id}/events`); interrupt is `POST /v1/sessions/{id}/interrupt`.
- The local embedded runtime emits the same event types, so `session.events()` code works unchanged.
- The `events` table is partitioned by day.

## Alternatives considered

- **Vendor-native stream formats.** Leaks vendor differences into every client.
- **Ephemeral pub/sub only.** No replay; reconnects lose output.

## Consequences

- The event log doubles as the source for the dashboard timeline and replay viewer.
- Event types are a public contract; changes need versioning care.
