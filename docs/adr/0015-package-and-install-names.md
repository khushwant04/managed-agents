# ADR-0015: Package and install names

- **Status:** Proposed
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** ADR-0012, [risks](../roadmap.md#risks), [open questions](../roadmap.md#open-questions)

## Context

The SDK examples use `from agents import Agent` and `import { Agent } from 'agents'`. Both names are taken: npm `agents` is Cloudflare's Agents SDK, and the Python module `agents` is what OpenAI's Agents SDK installs. Shipping under those names would cause install conflicts and confused users. The names must be fixed before v0.1 because they appear in every doc, example and import.

## Options

1. **Keep the `agents` import, publish under distinct distribution names** (for example a different PyPI project name and a scoped npm package). Short imports, but the Python module still collides with OpenAI's SDK if both are installed in one environment.
2. **Pick a fresh namespace** for both distribution and import names (for example a short project name used as `from <name> import Agent` and `@<scope>/<name>`). No collisions; costs renaming the docs.

## Recommendation

Option 2: a fresh namespace, used consistently for the PyPI package, the Python import, the npm scope and the CLI binary. A colliding Python import is a real problem in agent projects, where the OpenAI Agents SDK is a common dependency. The docs keep `agents` as a placeholder until this ADR is accepted.

## Consequences

- Once accepted: rename imports in all docs and examples, reserve the PyPI and npm names, and name the CLI to match.
