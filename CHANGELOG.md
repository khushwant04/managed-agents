# Changelog

All notable changes to Runhive are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, minor versions may contain breaking changes.

## [Unreleased]

## [0.1.0] - 2026-10-15

The first release: a pre-release, built and tested on scripted and recorded model responses but not yet run against live model APIs.

### Added

**Runtime and SDK (`runhive`)**
- `Agent`, `tool`, `Skill` and `Sandbox` for defining agents in Python or YAML, run locally by an embedded runtime.
- Runhive's own agent loop: tool calls, parallel tools, steering, interrupts, approvals with a `when` expression language, subagents and agent-to-agent calls, compaction and token, step and wall-clock budgets.
- Durable steps: every model and tool call is checkpointed. A run interrupted by a worker crash resumes on another worker by deterministic replay, without repeating completed steps.
- Model adapters:
  - Anthropic Messages API: adaptive thinking, prompt caching, server tools, refusal fallback;
  - OpenAI Responses API: reasoning effort, encrypted reasoning, native shell;
  - any OpenAI-compatible endpoint.
- Sandbox providers: E2B (E2B Cloud, or self-hosted E2B Embed through `E2B_API_URL` / `E2B_SANDBOX_URL`), Docker and local. Built-in shell, files and code tools.
- MCP and signed-webhook tools.
- `Client` / `AsyncClient` for the REST API, with resumable event streams.

**Server (`runhive-server`)**
- Gateway (FastAPI) with API keys and roles, per-project policy (allowed models, tools and agents, token budgets, egress domains), rate limits and an audit log.
- Registry of content-hashed agent versions with movable aliases, weighted traffic splits and rollback.
- Router: `name@alias` resolution, session affinity, model fallback on 429s, 5xx errors and refusals.
- Postgres run queue with leases (`FOR UPDATE SKIP LOCKED`), workers and a scheduler for cron triggers, retries and idle sandbox pausing.
- Deployments with HTTP, signed webhook (GitHub, Slack, Stripe, generic), cron and queue triggers.
- Event log with resumable SSE (`Last-Event-ID`) and WebSocket streams.
- AES-GCM envelope-encrypted secrets that never reach the model or the sandbox.
- Artifacts and skill bundles in S3-compatible storage.
- Prometheus metrics, OpenTelemetry traces and a Grafana dashboard.

**CLI (`runhive-cli`)**
- `runhive run`, `dev`, `apply`, `deploy`, `promote`, `rollback`, `invoke`, `versions`, `sessions`, `deployments` and `secrets`.
- `runhive e2b check`, which verifies an E2B setup end to end.

**TypeScript (`@runhive/client`, `@runhive/react`)**
- A fetch-based client typed from the OpenAPI spec, with SSE streaming and resume.
- React hooks `useSession` and `useEvents`.

**Console (`runhive-dashboard`)**
- A Next.js and shadcn/ui web console in the style of the Claude Console, with:
  - a home page with usage and recent sessions;
  - a playground with templates and code snippets;
  - agents, versions and aliases (promote, canary, rollback);
  - deployments, webhooks, secrets, environments and skills;
  - live session traces with approvals, steering and replay;
  - usage analytics, audit logs, API keys and settings.
- A key-hiding proxy: the API key stays in an httpOnly cookie on the dashboard's server.

**Deployment**
- Docker images `ghcr.io/khushwant04/runhive-server` and `ghcr.io/khushwant04/runhive-dashboard` (linux/amd64, linux/arm64), and the `runhive-base` E2B sandbox template.
- Docker Compose for local development.
- `deploy/e2b-embed`: Runhive and a self-hosted E2B runtime (E2B Embed) on one KVM host, set up by `up.sh`.
- Helm chart (gateway HPA, KEDA-scaled workers, dashboard, ingress for long-lived streams) and plain Kubernetes manifests for E2B Embed.

**Project**
- Apache-2.0 license (ADR-0016) and the Runhive name for every package, import and command (ADR-0015).
- Architecture docs, SDK and REST API references, the OpenAPI spec, and ADRs 0001–0020.
- The `incident-investigator` demo with a chaos test and a Claude vs GPT benchmark.

### Known limitations

- Not yet run against live model APIs. Tests use scripted and recorded responses, and the nightly live tests need provider keys.
- The packages are not on PyPI or npm yet. Install from the repository, or use the wheels attached to the GitHub release.
- The `runhive-base` template has not been built on E2B Cloud. On E2B Embed, `deploy/e2b-embed/up.sh` builds it.

[Unreleased]: https://github.com/khushwant04/managed-agents/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/khushwant04/managed-agents/releases/tag/v0.1.0
