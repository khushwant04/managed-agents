# ADR-0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Design plan](../design-plan.md)

## Context

The platform spans a registry, a router, a hosting layer, a runtime and two SDKs, built mostly by one person and meant to be read by newcomers and reviewers. Decisions made in the design plan (and later in code review) need a durable home that explains *why*, not just *what*, so contributors don't relitigate them and the project stays "small and readable".

## Decision

We will keep architecture decision records in `docs/adr/`, one Markdown file per decision, using the format in [template.md](template.md) (a lightweight variant of Michael Nygard's ADR format). The [index](README.md) lists every ADR with its status. Accepted ADRs are immutable; changes come as new ADRs that supersede old ones.

Open questions from the design plan are recorded as **Proposed** ADRs with a recommendation, so each one has a single place to be decided.

## Alternatives considered

- **Only the design plan.** It mixes decisions with exposition and will drift as the code evolves.
- **Wiki or issue threads.** Not versioned with the code; hard to find from a pull request.

## Consequences

- Significant changes (new adapter contract, storage changes, public API shape) need an ADR in the same PR.
- The design plan stays as the source document; ADRs and topic docs become the maintained reference.
