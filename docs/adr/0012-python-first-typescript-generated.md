# ADR-0012: Python SDK first; TypeScript client generated from OpenAPI

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Python SDK](../sdk/python.md), [TypeScript SDK](../sdk/typescript.md), [REST API](../api/rest.md), ADR-0015

## Context

Two SDKs maintained by hand drift apart, and building both before v0.1 risks shipping neither. Principle 7 is "library first, platform second": the same runtime must run embedded in a script and inside hosted deployments.

## Decision

- **Python ships first** and holds the full runtime: `Agent`, `tool`, `Skill`, the runtime, model adapters, sandbox providers, and `Client` / `AsyncClient`, built on asyncio, httpx and Pydantic. The server (`runhive-server`, FastAPI) reuses the same runtime package.
- Every call has a sync and an async form.
- The server publishes an **OpenAPI spec**. The **TypeScript** `Client` and types are **generated from it**, so the SDKs cannot drift. A TypeScript local runtime comes later.
- One monorepo holds all packages: `runhive` (PyPI), `runhive-server`, `runhive-cli`, `@runhive/client` (npm), and optionally `@runhive/react`. (The plan used `agents` as a placeholder; [ADR-0015](0015-package-and-install-names.md) settled the names.)

## Alternatives considered

- **TypeScript first.** Larger web audience, but the server and runtime are Python; two runtimes before v0.1 is too much.
- **Hand-written TypeScript client.** More idiomatic, but drifts.

## Consequences

- TypeScript users get a remote client in weeks 9 to 12, not a local runtime.
- The OpenAPI spec becomes a release artifact checked in CI.
- Final package names depend on ADR-0015.
