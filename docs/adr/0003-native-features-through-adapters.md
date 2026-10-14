# ADR-0003: Native model features through adapters with capability manifests

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Model adapters](../architecture/model-adapters.md), ADR-0002, ADR-0009

## Context

Multi-vendor runtimes usually flatten every API to a lowest common denominator, losing the features that make each model good: prompt caching, adaptive thinking and server tools on Claude; reasoning effort, built-in tools and background mode on OpenAI. Silently degrading a feature (or silently ignoring an option) makes behavior hard to predict.

## Decision

We will put each vendor behind a thin `ModelAdapter` that turns one normalized request into the vendor's raw API call and streams back normalized deltas. Native features are typed options on the agent definition, turned on per agent, never hidden.

Each adapter publishes a **capability manifest** per model (static tables, plus Claude's Models API `capabilities` object). Registration rejects any agent that asks for a feature one of its models cannot serve.

Portable options map across vendors (`reasoning: low|medium|high` → Claude effort / OpenAI reasoning effort). Anything else goes through an explicit escape hatch, `model_options["anthropic"]` or `model_options["openai"]`, flagged as non-portable.

```python
class ModelAdapter(Protocol):
    id: Literal["anthropic", "openai", "openai-compatible"]
    def capabilities(self, model: str) -> CapabilityManifest: ...
    def stream(self, req: ModelRequest) -> AsyncIterator[ModelDelta]: ...  # text, thinking, tool_call, usage
```

## Alternatives considered

- **Lowest common denominator.** Simple, but wastes each model's strengths and makes the project uninteresting.
- **Raw vendor passthrough only.** Maximum power, but agents stop being portable and fallbacks across vendors become impossible.

## Consequences

- Capability errors surface at registration, not mid-run.
- Manifests must be kept current as vendors ship features; stale manifests reject valid agents or accept invalid ones.
- Adapters also flag features that are not ZDR-eligible (for example Claude code execution, Files API, Agent Skills and the MCP connector).
