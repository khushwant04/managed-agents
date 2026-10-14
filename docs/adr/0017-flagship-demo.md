# ADR-0017: Flagship demo

- **Status:** Proposed
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [roadmap](../roadmap.md#what-makes-it-resume-ready), [open questions](../roadmap.md#open-questions)

## Context

The project ships with one polished demo, used in the README GIF, the chaos demo (kill a worker mid-run, watch the session resume) and the Claude vs. GPT benchmark. The demo should exercise registration, `name@alias` routing, triggers, the sandbox, tools and durability.

## Options

1. **Incident investigator.** Triggered by an alert webhook or cron; uses shell, web search, a webhook tool (`lookup_deploys`) and an observability MCP server; writes `/workspace/outputs/report.md`. Already the running example in the plan and the SDK docs. Needs a fake service and telemetry to investigate.
2. **GitHub issue fixer.** Triggered by a signed GitHub webhook; clones a repo into the sandbox, edits code, runs tests, opens a PR behind an approval. Very relatable and naturally long-running, but needs a GitHub App and a test repo, and benchmark results depend on the repo.

## Recommendation

Incident investigator for v0.1: it is already the running example, it exercises cron and webhook triggers, MCP and approvals, and its inputs can be fully recorded for a reproducible benchmark. The issue fixer is a strong second demo after v0.1.

## Consequences

- Once accepted: build a small fake service with injectable faults and recorded telemetry, plus a fixture set for the benchmark.
