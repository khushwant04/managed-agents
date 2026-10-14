# TypeScript SDK

The TypeScript SDK is the second SDK, planned for weeks 9 to 12 after v0.1 ([roadmap](../roadmap.md)). Its `Client` and types are **generated from the server's OpenAPI spec**, so it cannot drift from the Python SDK ([ADR-0012](../adr/0012-python-first-typescript-generated.md)). A local runtime comes later.

> The package name `agents` is a placeholder until [ADR-0015](../adr/0015-package-and-install-names.md) is decided: npm `agents` is Cloudflare's Agents SDK.

```ts
import { Client } from 'agents';

const client = new Client({ baseURL: 'https://agents.example.com' });
const session = await client.invoke('incident-investigator@prod', { input: 'Triage new alerts' });
for await (const ev of session.events()) {
  if (ev.type === 'message.agent.delta') process.stdout.write(ev.text);
}
```

## Scope

| Stage | Contents |
| --- | --- |
| First release | Generated `Client`, typed events, `Agent` definitions for registration |
| Later | Local runtime |
| Optional | `agents-react` hooks: `useSession`, `useEvents` |
