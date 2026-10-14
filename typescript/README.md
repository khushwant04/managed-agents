# TypeScript SDK

The TypeScript client for a managed-agents server, plus optional React hooks. Its types are **generated from the server's OpenAPI spec** (`docs/api/openapi.json`), so the TypeScript and Python SDKs cannot drift ([ADR-0012](../docs/adr/0012-python-first-typescript-generated.md)). The hand-written client on top mirrors the Python `agents.client` surface and semantics.

| Package | What it is |
| --- | --- |
| [`@managed-agents/client`](packages/client) | `fetch`-based client, typed events, SSE streaming with resume. No runtime dependencies. Node 18+ and browsers. |
| [`@managed-agents/react`](packages/react) | Optional `useSession` and `useEvents` hooks (React 18 or 19). |

> **Package names are placeholders.** npm `agents` belongs to Cloudflare, and the final names wait on [ADR-0015](../docs/adr/0015-package-and-install-names.md). Until that ADR is accepted, both packages use the `@managed-agents/*` scope and are marked `"private": true`, so they cannot be published by accident.

## Usage

```ts
import { Client } from '@managed-agents/client';

const client = new Client({ baseURL: 'https://agents.example.com' }); // apiKey defaults to AGENTS_API_KEY
const session = await client.invoke('incident-investigator@prod', { input: 'Triage new alerts' });
for await (const ev of session.events()) {
  if (ev.type === 'message.agent.delta') process.stdout.write(ev.text);
}
```

`new Client(options)` takes these options:

- `baseURL`: defaults to `AGENTS_BASE_URL`, then `http://localhost:8080`.
- `apiKey`: defaults to `AGENTS_API_KEY`. The environment is only read when `process.env` exists.
- `timeout`: per-request timeout in ms, 60 000 by default. For streams it only bounds connecting.
- `headers`: extra headers sent with every request.
- `fetch`: a custom `fetch`.

### Events

`session.events()` is an `AsyncIterable<Event>` over the session's server-sent events. Each event has the shape `{ id, session_id, run_id, seq, type, ts, model, payload }`. It also has `text`, which equals `payload.text ?? ''` (the Python `Event.text`). `type` is a string-literal union of every event type (`EventType`).

The stream follows the same rule as the Python `AsyncClient.stream_events`:

- **When it ends:** once the run settles. Any non-status event, or a `queued`/`running` status, marks the session as running. After that, an `idle`, `waiting_input`, `approval_pending` or `failed` status ends the stream. `terminated` ends it at any time.
- **Resume:** after a network error the client reconnects with `Last-Event-ID` (5 retries by default, exponential backoff capped at 10 s). The retry budget resets after every event received.
- **Cancel:** pass a `signal` to stop the stream. Stopping early with `break` also closes the connection.
- **Continuing a session:** calling `session.events()` again continues after the last event seen. For example, call `session.send('…')` and then iterate `session.events()` again.

```ts
const ac = new AbortController();
for await (const ev of client.streamEvents(sessionId, { after: 0, untilSettled: true, retries: 5, signal: ac.signal })) { … }
```

### Other calls

```ts
const { version } = await client.agents.register({ name: 'bot', models: ['claude-opus-5-5'], instructions: '…' });
await client.agents.promote('bot', version);                    // alias "prod" → version
await client.agents.setAlias('bot', 'prod', { 14: 90, 15: 10 }); // weighted split
await client.agents.canary('bot', 16, 10);                       // 10% to v16, rest stays on the current main version
await client.agents.rollback('bot');

const result = await client.run('bot@prod', 'Summarise #4411');  // sync mode: waits for the run
console.log(result.output);

const dep = await client.deployments.create('bot', { triggers: [{ type: 'http' }], secrets: ['GITHUB_TOKEN'] });
const s = await client.deployments.invoke(dep.id, 'go');
await s.wait();                                                    // drain until settled, then fetch the session
console.log(s.output);

const live = client.sessions.attach(sessionId);
await live.approve(callId);                                        // or live.deny(callId, 'reason')
```

| Resource | Methods |
| --- | --- |
| `client.agents` | `register`, `versions`, `get`, `search`, `setAlias`, `promote`, `canary`, `rollback`, `aliases`, `card` |
| `client.deployments` | `create`, `list`, `get`, `update`, `pause`, `resume`, `delete`, `invoke` |
| `client.sessions` | `get`, `list`, `attach`, `send`, `approve`, `deny`, `interrupt`, `terminate`, `artifacts`, `download` |
| `client.secrets` | `set`, `list`, `delete` |
| `client.environments` | `put`, `list` |
| `RemoteSession` | `events`, `history`, `send`, `approve`, `deny`, `interrupt`, `close`, `wait`, `output`, `artifacts`, `download` |

Request bodies use the generated types: `register()` takes the spec's `AgentSpec` (with `ToolRef`, `SkillRef`, `Limits` and so on), `deployments.create()` and `update()` take `DeploymentCreate` and `DeploymentUpdate`, and `environments.put()` takes `Environment`. Fields you leave out get the server's defaults. `sessions.download()` returns the artifact's bytes as a `Uint8Array`, whatever its content type.

For any endpoint without a wrapper (usage, audit, keys, project, skills, queues), use `client.call()`. It checks the path, method, path params, query, body and result against the generated types:

```ts
const usage = await client.call('get', '/v1/usage', { query: { days: 7 } });
```

Operations with a binary (`application/octet-stream`) response require `raw: true` and return a `Uint8Array`.

### Errors

Non-2xx responses throw `APIError` with these fields:

- `status`
- `error`: the server's `ErrorBody` (`{ error, message?, problems? }`). Every API error carries one; it is `undefined` only when something in between, such as a proxy, answered instead.
- `body`: the raw parsed body: the `ErrorBody`, other JSON, or the response text.
- `problems`: validation problems for agent definitions and request bodies, or `[]`.
- `code`: the server's error code, such as `not_found` or `invalid_definition`.

```ts
import { APIError } from '@managed-agents/client';
try {
  await client.agents.register(spec);
} catch (err) {
  if (err instanceof APIError && err.status === 422) console.error(err.problems);
}
```

### In the browser

The client uses `fetch` streams rather than `EventSource`, so the `Authorization` header works for streams too. The server must allow your origin (CORS), including the `Authorization` and `Last-Event-ID` request headers. Do not ship long-lived API keys to browsers. Proxy through your backend, or issue a short-lived key per user.

### React

```tsx
import { useSession } from '@managed-agents/react';

function Chat({ client, sessionId }) {
  const { events, status, pendingApprovals, send, approve } = useSession(client, sessionId);
  const text = events.filter((e) => e.type === 'message.agent.delta').map((e) => e.text).join('');
  …
}
```

`useEvents(client, sessionId, options?)` returns `{ events, status, done, error, resume }`. `useSession` adds the following:

- `session`: the record, reloaded whenever a run settles.
- `loading` and `pendingApprovals`.
- `refresh`, `send`, `approve`, `deny`, `interrupt` and `terminate`. Actions that start a run resume the stream automatically.

## Development

All commands run from `typescript/`. They need Node 22.12 or later, which the dev tooling requires; the published client itself runs on Node 18+.

```sh
npm install
npm run generate          # docs/api/openapi.json → packages/client/src/generated/schema.ts
npm run build             # tsc → packages/*/dist (ESM + .d.ts)
npm test                  # vitest, both packages
npx tsc --noEmit          # type-check every package, sources and tests
npm run check:generated   # fail if schema.ts is stale (CI)
```

### How regeneration works

1. The server's spec is exported to `docs/api/openapi.json` (`agents-server openapi > docs/api/openapi.json`).
2. `npm run generate` runs [`openapi-typescript`](https://openapi-ts.dev) at a pinned version, `7.13.0`. It writes `packages/client/src/generated/schema.ts`, which defines `paths`, `components` and `operations`. The generated file is committed.
3. The hand-written client in `packages/client/src` uses those types in two ways:
   - Public types such as `Session`, `Deployment` and `Event` are aliases of the generated schemas.
   - Every resource method goes through `client.call()`, which is typed against `paths`. If an endpoint is renamed or a body or response changes shape, `npx tsc --noEmit` fails until the wrapper is updated.
4. CI runs `npm run check:generated`. It regenerates into a temp file and diffs the result against the committed `schema.ts`, so a spec change without a regenerated client fails the build.

Generation uses `--default-non-nullable false`. Without that flag, openapi-typescript marks every field that has a default as required, request bodies included. It would then demand, for example, `stream` and `wait_timeout` on every invoke. This matters for `InvokeBody`, `AgentSpec`, `DeploymentCreate` and `Environment`, which all have defaulted fields. The cost is that defaulted response fields that the spec does not also list as required are typed as optional. `Event` lists all of its fields as required, so they are always present.

### Integration tests

`packages/client/test/integration.test.ts` talks to a real server. It is skipped unless `AGENTS_IT_BASE_URL` and `AGENTS_IT_API_KEY` are set. `scripts/it-server.py` starts a throwaway server for it. That server runs a private Postgres cluster, migrates it, and creates the admin key `ak_it_admin`. It registers a scripted model that answers every request with "pong", runs a worker with the local sandbox, and serves the API with uvicorn. Everything is removed on exit.

```sh
../.venv/bin/python scripts/it-server.py --port 8765 &
AGENTS_IT_BASE_URL=http://127.0.0.1:8765 AGENTS_IT_API_KEY=ak_it_admin npm run test:integration
kill %1
```

Set `TEST_DATABASE_URL` to use an existing Postgres server. The user in that URL must be allowed to create databases.

### Pinned tool versions

| Tool | Version |
| --- | --- |
| `openapi-typescript` | 7.13.0 |
| `typescript` | 5.9.3 |
| `vitest` | 4.1.11 |
| `vite` | 7.3.7 |
| `jsdom` | 29.1.1 |
| `@testing-library/react` | 16.3.3 |
| `react` / `react-dom` | 19.3.0 |

The root `package.json` overrides `vite` to 7.3.7. The newer vite resolves an optional peer back to `vitest@*`, and that crashes npm 10's peer resolution with `Cannot read properties of null (reading 'edgesOut')`.
