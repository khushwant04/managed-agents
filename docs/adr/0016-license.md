# ADR-0016: License

- **Status:** Proposed
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [open questions](../roadmap.md#open-questions)

## Context

The project is open source and meant to be self-hosted by others, including companies. The plan names Apache-2.0 in its summary but lists Apache-2.0 vs. MIT as an open question.

## Options

1. **Apache-2.0.** Permissive, with an explicit patent grant and patent-retaliation clause; common for infrastructure projects; requires a NOTICE file and stating changes.
2. **MIT.** Shortest and simplest permissive license; no explicit patent grant.

## Recommendation

Apache-2.0. The explicit patent grant matters more for infrastructure that companies run in production, and it matches the license used by many projects in the same space.

## Consequences

- Once accepted: add `LICENSE` (and `NOTICE` if Apache-2.0), add license headers or SPDX identifiers to source files, and set license metadata in `pyproject.toml` and `package.json`.
