# ADR-0016: License

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** @khushwant04
- **Related:** [open questions](../roadmap.md#open-questions)

## Context

The project is open source and meant to be self-hosted by others, including companies. The plan names Apache-2.0 in its summary but lists Apache-2.0 vs. MIT as an open question.

## Options

1. **Apache-2.0.** Permissive, with an explicit patent grant and patent-retaliation clause; common for infrastructure projects; requires a NOTICE file and stating changes.
2. **MIT.** Shortest and simplest permissive license; no explicit patent grant.

## Decision

Apache-2.0. The explicit patent grant matters for infrastructure that companies run in production, and it matches projects in the same space (E2B, Temporal, LangChain).

## Consequences

- `LICENSE` (the unmodified Apache-2.0 text) and `NOTICE` are at the repository root. Copies of `LICENSE` sit in each published package directory, because packages can only include files from their own directory.
- License metadata: `license = "Apache-2.0"` in every `pyproject.toml` (SPDX expression, PEP 639); `"license": "Apache-2.0"` in every `package.json`; `org.opencontainers.image.licenses="Apache-2.0"` on the server and dashboard images.
- Per-file license headers are not required by Apache-2.0 and are not added. New files are covered by the repository `LICENSE`.
- Contributions are accepted under the same license (Apache-2.0, section 5).
