# TypeScript SDK

The TypeScript SDK lives in [`typescript/`](../../typescript/README.md). Its types are **generated from the server's OpenAPI spec** ([`docs/api/openapi.json`](../api/openapi.json)) with `openapi-typescript`, and a thin hand-written client is typed against them, so a spec change that the client doesn't follow fails type-checking ([ADR-0012](../adr/0012-python-first-typescript-generated.md)). `npm run check:generated` fails CI when the generated file is stale. A local runtime comes later.

> Package names are placeholders until [ADR-0015](../adr/0015-package-and-install-names.md) is decided (npm `agents` is Cloudflare's Agents SDK): `@managed-agents/client` and `@managed-agents/react`, both `private` for now.

```ts
import { Client } from '@managed-agents/client';

const client = new Client({ baseURL: 'https://agents.example.com' }); // apiKey defaults to AGENTS_API_KEY
const session = await client.invoke('incident-investigator@prod', { input: 'Triage new alerts' });
for await (const ev of session.events()) {
  if (ev.type === 'message.agent.delta') process.stdout.write(ev.text);
}
```

## Surface

Mirrors the Python `AsyncClient`: `client.agents` (`register`, `versions`, `get`, `search`, `setAlias`, `promote`, `canary`, `rollback`, `aliases`, `card`), `client.deployments`, `client.sessions` (including `approve`/`deny`), `client.secrets`, `client.environments`, `client.invoke` and `client.run`. `client.call(method, path, ...)` reaches any endpoint with types from the spec. `events()` follows SSE until the run settles and reconnects with `Last-Event-ID`; streams accept an `AbortSignal`. Errors are `APIError` with `status`, `body` and `problems`. Timeouts are in milliseconds.

Agent definitions are plain `AgentSpec` objects (there is no `Agent` builder in TypeScript yet).

## React

`@managed-agents/react` provides `useEvents(client, sessionId)` and `useSession(client, sessionId)` (session record, pending approvals, `send`, `approve`, `deny`, `interrupt`, `terminate`) for React 18 and 19.
