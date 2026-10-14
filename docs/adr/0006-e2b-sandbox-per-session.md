# ADR-0006: One E2B sandbox per session behind a pluggable `SandboxProvider`

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Infrastructure](../architecture/infrastructure.md#sandboxes-on-e2b), [Security and operations](../architecture/security-operations.md), ADR-0009

## Context

Agents run shell commands, edit files and execute code they wrote. That code is untrusted and must be isolated per session and per tenant. Running a VM fleet is out of scope for a one-person project; local development must work without cloud credentials.

## Decision

Each session gets its own sandbox through a `SandboxProvider` interface. **E2B is the default provider** (a Firecracker microVM per sandbox); a **Docker provider** exists for local development.

- Sandboxes are created from a template `agents-base` (Ubuntu, bash, Python, Node, git) built from a Dockerfile in the repo.
- Workers drive the sandbox through the provider's command and file APIs. Because the harness is ours, nothing agent-specific runs inside the sandbox.
- Layout: skills in `/workspace/skills`, inputs in `/workspace/inputs`, outputs in `/workspace/outputs` (synced to object storage on `artifact.created` and at idle), memory in `/workspace/memory`.
- Idle sessions pause the sandbox where the plan supports it; otherwise `/workspace` is snapshotted and restored into a new sandbox on the next input.
- Sandboxes are never shared across tenants, have a hard timeout, hold no platform credentials, and have restricted network access where the provider allows it.

```python
class SandboxProvider(Protocol):
    async def create(self, env: Environment) -> SandboxHandle: ...
    async def exec(self, h: SandboxHandle, cmd: str, timeout: float | None = None) -> ExecResult: ...
    async def write_files(self, h: SandboxHandle, files: list[FileSpec]) -> None: ...
    async def read_files(self, h: SandboxHandle, paths: list[str]) -> list[FileSpec]: ...
    async def pause(self, h: SandboxHandle) -> None: ...      # optional
    async def destroy(self, h: SandboxHandle) -> None: ...
```

## Alternatives considered

- **Vendor-hosted code execution** (Claude code execution, OpenAI code interpreter). Behavior differs per model and state lives outside our control.
- **Own Firecracker/gVisor fleet.** Strong isolation, far too much infrastructure for v1.
- **Plain Docker in production.** Weaker isolation for untrusted, multi-tenant code.

## Consequences

- E2B cost and limits on long sessions become a risk; mitigated with hard timeouts, pause/snapshot when idle, and Docker for dev.
- A new provider is one class implementing the protocol.
