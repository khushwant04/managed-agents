# ADR-0009: Portable built-in tools run in our sandbox with vendor-native schemas

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Tools, skills and memory](../architecture/tools-skills-memory.md), [Model adapters](../architecture/model-adapters.md#mapping-rules), ADR-0003, ADR-0006

## Context

Models are trained on specific tool schemas (Claude's bash and text editor tools; OpenAI's shell and apply patch) and use them best in that shape. But if each vendor also *executes* those tools on its own infrastructure, behavior and state differ per model and a session cannot switch vendors.

## Decision

The runtime, not the model, decides where a tool runs.

- **Portable built-ins** `shell`, `files` and `code` always execute in our E2B sandbox, so behavior is identical across models. The adapter **presents** them to each model with the schema that model was trained on.
- **Web tools** `web_search` and `web_fetch` use the vendor's server-side tool when present, otherwise our own search-API tool; both honor domain allow and block lists.
- **Function tools** run either as HMAC-signed webhooks through the tool gateway (retried, idempotency key per call) or as scripts shipped with the agent version and run in the sandbox.
- **MCP servers** are reached through the tool gateway acting as MCP client, with secrets injected; tools are listed at run start, with tool search when there are many.
- **`call_agent`** goes through the router (ADR-0007).

## Alternatives considered

- **One generic schema for every model.** Portable, but measurably worse tool use.
- **Vendor-executed tools.** Less work, but state splits across vendors and portability is lost.

## Consequences

- Adapters carry schema translation code for each portable built-in.
- Server-side web tools may differ slightly between vendors; this is accepted because they are stateless.
