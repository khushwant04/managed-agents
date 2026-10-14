import { describe, expect, it } from 'vitest';
import { Client, RemoteSession } from '../src/index.js';
import { json, mockFetch, type Recorded } from './helpers.js';

/** Answers every request with a generic body that satisfies the list-unwrapping methods. */
function setup(answer: (req: Recorded) => Response | undefined = () => undefined) {
  const lists = { versions: [], agents: [], aliases: [], deployments: [], sessions: [], artifacts: [], secrets: [], environments: [], events: [] };
  const { fetch, calls } = mockFetch((req) => answer(req) ?? (req.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ ...lists, session_id: 's', run_id: 'r' })));
  return { client: new Client({ baseURL: 'http://api.test', apiKey: 'k', fetch }), calls };
}

type Case = [string, (c: Client) => Promise<unknown>, string, string, unknown?];

const cases: Case[] = [
  ['agents.register', (c) => c.agents.register({ name: 'bot', models: ['scripted'] }), 'POST', '/v1/agents', { name: 'bot', models: ['scripted'] }],
  ['agents.versions', (c) => c.agents.versions('bot'), 'GET', '/v1/agents/bot/versions'],
  ['agents.get', (c) => c.agents.get('bot', 3), 'GET', '/v1/agents/bot/versions/3'],
  ['agents.search', (c) => c.agents.search('inc', { tag: 'ops' }), 'GET', '/v1/agents?q=inc&tag=ops'],
  ['agents.search (no filters)', (c) => c.agents.search(), 'GET', '/v1/agents'],
  ['agents.setAlias (map)', (c) => c.agents.setAlias('bot', 'prod', { 14: 90, 15: 10 }), 'PUT', '/v1/agents/bot/aliases/prod', { versions: [{ version: 14, weight: 90 }, { version: 15, weight: 10 }] }],
  ['agents.setAlias (list)', (c) => c.agents.setAlias('bot', 'prod', [{ version: 2, weight: 100 }]), 'PUT', '/v1/agents/bot/aliases/prod', { versions: [{ version: 2, weight: 100 }] }],
  ['agents.promote', (c) => c.agents.promote('bot', 4), 'PUT', '/v1/agents/bot/aliases/prod', { versions: [{ version: 4, weight: 100 }] }],
  ['agents.rollback', (c) => c.agents.rollback('bot', 'staging'), 'POST', '/v1/agents/bot/aliases/staging/rollback'],
  ['agents.aliases', (c) => c.agents.aliases('bot'), 'GET', '/v1/agents/bot/aliases'],
  ['agents.card', (c) => c.agents.card('bot@prod'), 'GET', '/v1/agents/bot@prod/card'],
  ['deployments.create', (c) => c.deployments.create('bot', { version: 2, secrets: ['TOKEN'] }), 'POST', '/v1/deployments', { agent: 'bot', version: 2, secrets: ['TOKEN'] }],
  ['deployments.list', (c) => c.deployments.list(), 'GET', '/v1/deployments'],
  ['deployments.get', (c) => c.deployments.get('dep_1'), 'GET', '/v1/deployments/dep_1'],
  ['deployments.update', (c) => c.deployments.update('dep_1', { concurrency: 3 }), 'PATCH', '/v1/deployments/dep_1', { concurrency: 3 }],
  ['deployments.pause', (c) => c.deployments.pause('dep_1'), 'PATCH', '/v1/deployments/dep_1', { status: 'paused' }],
  ['deployments.resume', (c) => c.deployments.resume('dep_1'), 'PATCH', '/v1/deployments/dep_1', { status: 'active' }],
  ['deployments.delete', (c) => c.deployments.delete('dep_1'), 'DELETE', '/v1/deployments/dep_1'],
  ['deployments.invoke', (c) => c.deployments.invoke('dep_1', 'go'), 'POST', '/v1/deployments/dep_1/invoke', { input: 'go', mode: 'async', metadata: {} }],
  ['sessions.get', (c) => c.sessions.get('ses_1'), 'GET', '/v1/sessions/ses_1'],
  ['sessions.list', (c) => c.sessions.list(), 'GET', '/v1/sessions?limit=50'],
  ['sessions.list (agent)', (c) => c.sessions.list({ agent: 'bot', limit: 5 }), 'GET', '/v1/sessions?limit=5&agent=bot'],
  ['sessions.send', (c) => c.sessions.send('ses_1', 'hi'), 'POST', '/v1/sessions/ses_1/events', { type: 'message.user', text: 'hi' }],
  ['sessions.approve', (c) => c.sessions.approve('ses_1', 'call_1'), 'POST', '/v1/sessions/ses_1/events', { type: 'tool.approval.decided', call_id: 'call_1', approved: true, reason: null }],
  ['sessions.deny', (c) => c.sessions.deny('ses_1', 'call_1', 'no'), 'POST', '/v1/sessions/ses_1/events', { type: 'tool.approval.decided', call_id: 'call_1', approved: false, reason: 'no' }],
  ['sessions.interrupt', (c) => c.sessions.interrupt('ses_1'), 'POST', '/v1/sessions/ses_1/interrupt'],
  ['sessions.terminate', (c) => c.sessions.terminate('ses_1'), 'DELETE', '/v1/sessions/ses_1'],
  ['sessions.artifacts', (c) => c.sessions.artifacts('ses_1'), 'GET', '/v1/sessions/ses_1/artifacts'],
  ['secrets.set', (c) => c.secrets.set('TOKEN', 's3cret'), 'POST', '/v1/secrets', { name: 'TOKEN', value: 's3cret' }],
  ['secrets.list', (c) => c.secrets.list(), 'GET', '/v1/secrets'],
  ['secrets.delete', (c) => c.secrets.delete('TOKEN'), 'DELETE', '/v1/secrets/TOKEN'],
  ['environments.put', (c) => c.environments.put('gpu', { provider: 'docker', cpu: 4 }), 'POST', '/v1/environments', { name: 'gpu', provider: 'docker', cpu: 4 }],
  ['environments.list', (c) => c.environments.list(), 'GET', '/v1/environments'],
  ['run', (c) => c.run('bot@prod', 'q', { timeout: 10_000 }), 'POST', '/v1/agents/bot@prod/invoke', { input: 'q', mode: 'sync', wait_timeout: 10 }],
  ['invoke (metadata)', (c) => c.invoke('bot', { input: 'q', metadata: { ticket: 7 } }), 'POST', '/v1/agents/bot/invoke', { input: 'q', mode: 'async', metadata: { ticket: 7 } }],
  ['call (escape hatch)', (c) => c.call('get', '/v1/usage', { query: { days: 7 } }), 'GET', '/v1/usage?days=7'],
];

describe('resource request shapes', () => {
  it.each(cases)('%s', async (_, fn, method, pathAndQuery, body) => {
    const { client, calls } = setup();
    await fn(client);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.method).toBe(method);
    expect(req.path + req.url.search).toBe(pathAndQuery);
    expect(req.body).toEqual(body);
    expect(req.headers.get('authorization')).toBe('Bearer k');
    if (body !== undefined) expect(req.headers.get('content-type')).toBe('application/json');
  });

  it('encodes path segments but keeps @ readable', async () => {
    const { client, calls } = setup();
    await client.agents.card('my bot/x@prod');
    expect(calls[0]!.url.pathname).toBe('/v1/agents/my%20bot%2Fx@prod/card');
  });

  it('unwraps list responses', async () => {
    const { client } = setup((req) => (req.path === '/v1/deployments' ? json({ deployments: [{ id: 'dep_1' }] }) : undefined));
    expect(await client.deployments.list()).toEqual([{ id: 'dep_1' }]);
  });

  it('canary splits traffic between the current main version and the new one', async () => {
    const { client, calls } = setup((req) =>
      req.method === 'GET' ? json({ aliases: [{ alias: 'prod', versions: [{ version: 3, weight: 100 }], updated_at: 'now' }] }) : undefined,
    );
    await client.agents.canary('bot', 4, 10);
    expect(calls[1]!.body).toEqual({ versions: [{ version: 3, weight: 90 }, { version: 4, weight: 10 }] });
    const { client: c2 } = setup((req) => (req.method === 'GET' ? json({ aliases: [] }) : undefined));
    await expect(c2.agents.canary('bot', 4, 10)).rejects.toThrow("bot has no alias 'prod' yet");
  });

  it('attach returns a RemoteSession without a request', () => {
    const { client, calls } = setup();
    const s = client.sessions.attach('ses_7');
    expect(s).toBeInstanceOf(RemoteSession);
    expect(s.id).toBe('ses_7');
    expect(calls).toHaveLength(0);
  });

  it('download returns bytes even for JSON artifacts, and empty files as empty bytes', async () => {
    const { client, calls } = setup((req) => (req.path.endsWith('/empty') ? new Response('', { status: 200 }) : json({ a: 1 })));
    const bytes = await client.sessions.download('ses_1', 'art_1');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe('{"a":1}');
    expect(calls[0]!.path).toBe('/v1/sessions/ses_1/artifacts/art_1');
    expect(calls[0]!.headers.get('accept')).toBe('*/*');
    expect(await client.sessions.download('ses_1', 'empty')).toEqual(new Uint8Array());
  });

  it('history maps stored events', async () => {
    const { client, calls } = setup(() => json({ events: [{ session_id: 's', seq: 1, type: 'message.agent.delta', payload: { text: 'x' } }] }));
    const events = await client.sessions.attach('s').history(0);
    expect(events[0]!.text).toBe('x');
    expect(calls[0]!.path + calls[0]!.url.search).toBe('/v1/sessions/s/events?after=0');
  });
});
