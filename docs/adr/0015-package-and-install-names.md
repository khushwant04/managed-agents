# ADR-0015: Package and install names

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** @khushwant04
- **Related:** ADR-0012, [risks](../roadmap.md#risks), [open questions](../roadmap.md#open-questions)

## Context

The plan's examples used `from agents import Agent` and `import { Agent } from 'agents'`. Both names are taken: npm `agents` is Cloudflare's Agents SDK, and the Python module `agents` is what OpenAI's Agents SDK installs. Shipping under those names would cause install conflicts and confused users. The names had to be fixed before v0.1 because they appear in every doc, example and import.

## Options

1. **Keep the `agents` import, publish under distinct distribution names** (for example a different PyPI project name and a scoped npm package). Short imports, but the Python module still collides with OpenAI's SDK if both are installed in one environment.
2. **Pick a fresh namespace** for both distribution and import names, used for the PyPI package, the Python import, the npm scope and the CLI binary. No collisions; costs renaming the docs.

## Decision

Option 2, under the brand name **Runhive** ("run your hive of agents"). The name was free on PyPI, on npm and as a GitHub organisation ([github.com/runhive](https://github.com/runhive)) when chosen.

| Surface | Name |
| --- | --- |
| Product | Runhive |
| PyPI distributions | `runhive`, `runhive-server`, `runhive-cli` |
| Python imports | `runhive`, `runhive_server`, `runhive_cli` |
| Commands | `runhive` (CLI), `runhive-server` (server) |
| npm packages | `@runhive/client`, `@runhive/react` (dashboard: `@runhive/dashboard`, private) |
| Environment variables | `RUNHIVE_*` (for example `RUNHIVE_API_KEY`, `RUNHIVE_BASE_URL`, `RUNHIVE_API_URL`) |
| Container images, Helm chart | `runhive`, `runhive-dashboard`; chart `deploy/helm/runhive` |
| E2B template | `runhive-base` |
| Prometheus metrics, Postgres channels, OTel attributes | `runhive_*`, `runhive.*` |
| Webhook headers | `X-Runhive-Signature`, `X-Runhive-Event` |
| Docs site | `runhive.github.io` |

## Consequences

- Every package, import, command, environment variable, image and doc uses the new names. Nothing ships under `agents`.
- Before the first release, reserve the names: placeholder packages on PyPI (`runhive`, `runhive-server`, `runhive-cli`) and the `runhive` npm organisation.
- The repository can move to the `runhive` GitHub organisation; links in the docs point at the current repository until it does.
- `docs/design-plan.md` keeps the plan as written, with the `agents` placeholder.
