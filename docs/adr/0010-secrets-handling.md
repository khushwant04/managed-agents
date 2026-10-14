# ADR-0010: Secrets are encrypted and injected at the tool gateway only

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Security and operations](../architecture/security-operations.md), ADR-0006, ADR-0009

## Context

Agents call tools that need credentials (MCP tokens, webhook keys, cloud APIs), and the platform holds bring-your-own Anthropic and OpenAI keys per project. Anything that reaches model context can leak through prompt injection; anything in the sandbox is reachable by agent-written code.

## Decision

- Secrets are stored with **AES-GCM envelope encryption**; the master key comes from an environment variable or a cloud KMS.
- Agents and tools reference secrets **by name**. The tool gateway (inside workers in v1) injects them at call time.
- Secrets never enter model context and never enter the sandbox's environment.
- Provider keys are per project, encrypted, and used only by workers.
- Secret reads are recorded in the audit log.

## Alternatives considered

- **Environment variables in the sandbox.** Simple, but any agent-written code can read and exfiltrate them.
- **External vault only.** Good for larger operators; can be added later as a key source without changing the reference-by-name model.

## Consequences

- Tools that need credentials must run through the tool gateway (webhook or MCP), not as raw sandbox scripts.
- Rotation is a metadata change; references by name stay valid.
