# ADR-0011: The runtime owns the transcript, allowing model switches between runs

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Model adapters](../architecture/model-adapters.md#switching-models), ADR-0002, ADR-0007

## Context

Vendor APIs offer server-held conversation state (for example OpenAI response IDs). Relying on it ties a session to one vendor and makes fallbacks across vendors, replay and self-hosted storage harder.

## Decision

The runtime keeps the canonical transcript in its own normalized form, stored with the session's steps. Vendor-side state such as OpenAI response IDs is used only as a cache optimization, never as the source of truth.

Because of this, a session may change model **between runs** (for example GPT to plan, Claude to execute), and model fallbacks can cross vendors. When crossing vendors, vendor-specific blocks such as thinking signatures are dropped, and the prompt cache starts cold.

## Alternatives considered

- **Vendor-held state.** Less storage and simpler adapters, but no portability or offline replay.

## Consequences

- Adapters must convert the normalized transcript to each vendor format on every call.
- Prompt order must stay cache-friendly (stable system prompt and tools first) so caching still pays off.
- Neither reference product supports cross-vendor sessions; this is a differentiator.
