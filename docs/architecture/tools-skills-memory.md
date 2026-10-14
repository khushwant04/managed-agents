# Tools, MCP, skills and memory

Tools run in one of three places: the E2B sandbox, the tool gateway, or the model vendor (server-side tools). The runtime decides where, never the model ([ADR-0009](../adr/0009-portable-built-in-tools.md)).

| Type | Executes in | Notes |
| --- | --- | --- |
| Built-in `shell`, `files`, `code` | E2B sandbox, via the E2B SDK | Same behavior for every model; schema matched to each model's native tool |
| Built-in `web_search`, `web_fetch` | Vendor server-side tool, or our search-API tool | Domain allow and block lists |
| Function (webhook) | Tool gateway → your HTTPS endpoint | HMAC-signed, retried, idempotency key per call |
| Function (sandbox script) | E2B sandbox | Code shipped with the agent version |
| MCP server | Tool gateway acting as MCP client | Secrets injected; tools listed at run start; tool search when there are many |
| `call_agent` | Router | Starts or resumes another registered agent and returns its output |

## Webhook tools

A function decorated with `@tool(url=...)` runs in-process when the agent runs locally, and as a signed webhook when hosted.

The tool gateway sends a POST with the validated arguments, an idempotency key and an HMAC signature. It retries on failure; receivers should deduplicate by idempotency key, which stays the same when a run resumes after a crash ([ADR-0005](../adr/0005-durable-execution-on-postgres.md)). The exact header names and signature format are to be fixed with the server API.

## Approvals

Each tool carries `approval: never | always | { when: <expr> }`. A matching call pauses the run (`approval_pending`), emits `tool.approval.requested`, and resumes on an approval event. Same flow for every model ([ADR-0014](../adr/0014-tool-approvals-as-policy.md)).

```bash
curl -X POST https://agents.example.com/v1/sessions/$SESSION_ID/events \
  -H "Authorization: Bearer $AGENTS_API_KEY" \
  -d '{"type": "tool.approval.decided", "call_id": "call_123", "decision": "approve"}'
```

(Request body illustrative.)

## Secrets

Stored encrypted, referenced by name, injected by the tool gateway at call time. They never enter model context or the sandbox's environment ([ADR-0010](../adr/0010-secrets-handling.md)).

## Skills

A skill is a versioned folder (`SKILL.md` plus scripts) registered like an agent. At session start it is copied to `/workspace/skills/<name>`; the runtime lists each skill's name and description in the system prompt, and the model opens `SKILL.md` only when it needs it. This progressive loading works on any model ([ADR-0013](../adr/0013-skills-as-versioned-folders.md)).

```text
skills/runbooks/
├── SKILL.md          # name, description, then instructions
└── scripts/
    └── check_error_budget.py
```

## Memory

- **Within a session:** handled by the runtime's context management (native compaction where available).
- **Across sessions:** a per-agent memory store synced as files into `/workspace/memory`; on Claude the adapter exposes it through the native memory tool schema, with storage implemented by us.
