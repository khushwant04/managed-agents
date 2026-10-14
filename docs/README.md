# Documentation

Start with the [design plan](design-plan.md) for the full picture, or jump to a topic.

## Architecture

- [Overview](architecture/overview.md): planes, components, diagram, request path
- [Core abstractions](architecture/core-abstractions.md): the twelve objects, session states, event schema
- [Registration, routing and hosting](architecture/registry-routing-hosting.md)
- [Agent runtime](architecture/runtime.md): the harness and its interfaces
- [Model adapters](architecture/model-adapters.md): native features and mapping rules
- [Tools, skills and memory](architecture/tools-skills-memory.md)
- [Infrastructure](architecture/infrastructure.md): components, data stores, sandboxes, deployment
- [Security and operations](architecture/security-operations.md): trust zones, tenancy, observability, cost

## SDKs and API

- [Python SDK](sdk/python.md)
- [TypeScript SDK](sdk/typescript.md)
- [REST API](api/rest.md)

## Context and planning

- [Reference designs](reference-designs.md): Claude Managed Agents and OpenAI Agents API
- [Roadmap, risks and open questions](roadmap.md)
- [Architecture decision records](adr/README.md)

## Writing docs

- Decisions go in an ADR ([process](adr/README.md#process)); topic docs link to the ADRs they depend on.
- Diagrams use Mermaid so they render on GitHub and stay diffable.
- Code samples that show APIs not yet implemented are marked illustrative.
