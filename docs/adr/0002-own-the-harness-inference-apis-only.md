# ADR-0002: Own the harness; call only model inference APIs

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Reference designs](../reference-designs.md), [Agent runtime](../architecture/runtime.md), ADR-0003, ADR-0011

## Context

Claude Managed Agents and OpenAI's Agents API both offer hosted agents with a vendor-run harness and sandbox. Using either would be faster to start, but each ties session state, tools and sandboxes to one vendor, neither lets a session move between vendors, and both carry data limits (neither is ZDR-eligible; OpenAI's is US-residency only even when self-hosted). The goal is a self-hosted platform where session state lives in the operator's Postgres and only model calls leave.

## Decision

We will own every layer of the platform (registry, routing, hosting and the agent loop) and call only model inference APIs: the Anthropic Messages API, the OpenAI Responses API, and OpenAI-compatible Chat Completions endpoints. The two managed products are studied as reference designs for their object model (Agent, Environment, Session, Event) and their separation of harness and sandbox, but are never called at runtime.

## Alternatives considered

- **Wrap the managed-agent APIs.** Fast, but inherits their data posture and lock-in, and cannot route one session across vendors.
- **Build on an existing agent framework.** Saves loop code but hides the durability and checkpoint semantics this project needs to own (ADR-0005).

## Consequences

- We maintain the tool loop, compaction fallback, steering, approvals and subagents ourselves.
- Vendor API changes hit our adapters directly; mitigated by contract tests on recorded responses and nightly live tests (see [risks](../roadmap.md#risks)).
- Full self-hosting becomes possible, and a session can switch between Claude and GPT between runs (ADR-0011).
