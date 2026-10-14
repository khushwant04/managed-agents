/**
 * End-to-end tests against a real server. Skipped unless both are set:
 *
 *   AGENTS_IT_BASE_URL  e.g. http://127.0.0.1:8765
 *   AGENTS_IT_API_KEY   e.g. ak_it_admin
 *
 * `typescript/scripts/it-server.py` starts a suitable throwaway server whose model
 * `scripted` answers every request with "pong".
 */
import { describe, expect, it } from 'vitest';
import { APIError, Client, type Event } from '../src/index.js';

const baseURL = process.env.AGENTS_IT_BASE_URL;
const apiKey = process.env.AGENTS_IT_API_KEY;
const enabled = Boolean(baseURL && apiKey);

const suffix = Math.random().toString(36).slice(2, 8);
const agent = `it-pong-${suffix}`;

describe.skipIf(!enabled)('integration (real server)', { timeout: 60_000 }, () => {
  const client = new Client({ baseURL, apiKey });

  it('registers an agent, versions it and routes an alias', async () => {
    const reg = await client.agents.register({ name: agent, models: ['scripted'], instructions: 'Answer pong.', tags: ['it'] });
    expect(reg).toMatchObject({ name: agent, version: 1, created: true });
    const again = await client.agents.register({ name: agent, models: ['scripted'], instructions: 'Answer pong.', tags: ['it'] });
    expect(again.created).toBe(false);
    const v2 = await client.agents.register({ name: agent, models: ['scripted'], instructions: 'Answer pong, v2.', tags: ['it'] });
    expect(v2.version).toBe(2);

    expect((await client.agents.versions(agent)).map((v) => v.version)).toEqual([2, 1]);
    expect((await client.agents.get(agent, 1)).version).toBe(1);
    await client.agents.promote(agent, 1);
    const canary = await client.agents.canary(agent, 2, 20);
    expect(canary.versions).toEqual([
      { version: 1, weight: 80 },
      { version: 2, weight: 20 },
    ]);
    expect((await client.agents.rollback(agent)).versions).toEqual([{ version: 1, weight: 100 }]);
    await client.agents.setAlias(agent, 'prod', { 2: 100 });
    expect((await client.agents.aliases(agent)).find((a) => a.alias === 'prod')?.versions).toEqual([{ version: 2, weight: 100 }]);
    const card = await client.agents.card(`${agent}@prod`);
    expect(card.name).toBe(agent);
    expect((await client.agents.search(agent.slice(0, 10))).map((a) => a.name)).toContain(agent);
  });

  it('reports definition problems as APIError.problems', async () => {
    const err = (await client.agents.register({ name: `bad-${suffix}`, models: ['nope-model'], tools: [{ type: 'function', name: 'f' }] }).catch((e: unknown) => e)) as APIError;
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(422);
    expect(err.problems.length).toBeGreaterThan(0);
  });

  it('invokes, streams events until settled, then continues the session', async () => {
    const session = await client.invoke(`${agent}@prod`, { input: 'ping', metadata: { source: 'ts-it' } });
    const seen: Event[] = [];
    let text = '';
    for await (const ev of session.events()) {
      seen.push(ev);
      if (ev.type === 'message.agent.delta') text += ev.text;
    }
    expect(text.trim()).toBe('pong');
    expect(seen[0]?.type).toBe('route.resolved');
    const last = seen.at(-1)!;
    expect(last.type).toBe('session.status');
    expect(last.payload.status).toBe('idle');
    expect(seen.map((e) => e.seq)).toEqual(seen.map((_, i) => i + 1));

    const info = await client.sessions.get(session.id);
    expect(info.status).toBe('idle');
    expect(info.metadata).toMatchObject({ source: 'ts-it' });

    await session.send('ping again');
    const after = await session.wait();
    expect(after.status).toBe('idle');
    expect(session.output.trim()).toBe('pong');

    const history = await session.history();
    expect(history.filter((e) => e.type === 'message.user').map((e) => e.text)).toEqual(['ping', 'ping again']);

    // Resuming from an explicit point replays only what came after it.
    const replay: number[] = [];
    for await (const ev of client.streamEvents(session.id, { after: 3 })) replay.push(ev.seq);
    expect(replay[0]).toBe(4);

    expect((await client.sessions.list({ agent })).map((s) => s.id)).toContain(session.id);
    expect(await session.artifacts()).toEqual([]);
    await session.close();
    expect((await client.sessions.get(session.id)).status).toBe('terminated');
  });

  it('runs synchronously', async () => {
    const result = await client.run(`${agent}@prod`, 'ping', { timeout: 60_000 });
    expect(result.status).toBeDefined();
    expect(result.output?.trim()).toBe('pong');
    expect(result.agent).toBe(agent);
  });

  it('manages deployments and invokes through one', async () => {
    const dep = await client.deployments.create(agent, { name: `${agent}-dep`, concurrency: 2 });
    expect(dep).toMatchObject({ agent, alias: 'prod', concurrency: 2, status: 'active' });
    expect((await client.deployments.list()).map((d) => d.id)).toContain(dep.id);
    expect((await client.deployments.get(dep.id)).name).toBe(`${agent}-dep`);
    expect((await client.deployments.pause(dep.id)).status).toBe('paused');
    expect((await client.deployments.resume(dep.id)).status).toBe('active');
    const session = await client.deployments.invoke(dep.id, 'ping');
    const info = await session.wait();
    expect(info.deployment_id).toBe(dep.id);
    expect(session.output.trim()).toBe('pong');
    await client.deployments.delete(dep.id);
    const err = (await client.deployments.get(dep.id).catch((e: unknown) => e)) as APIError;
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(404);
  });

  it('manages secrets and environments', async () => {
    const name = `IT_SECRET_${suffix.toUpperCase()}`;
    expect((await client.secrets.set(name, 's3cret')).name).toBe(name);
    expect((await client.secrets.list()).map((s) => s.name)).toContain(name);
    await client.secrets.delete(name);
    expect((await client.secrets.list()).map((s) => s.name)).not.toContain(name);

    const env = await client.environments.put(`it-env-${suffix}`, { provider: 'local', timeout_s: 60 });
    expect(env).toMatchObject({ name: `it-env-${suffix}`, provider: 'local', timeout_s: 60 });
    expect((await client.environments.list()).map((e) => e.name)).toContain(`it-env-${suffix}`);
  });

  it('maps errors from the server', async () => {
    const err = (await client.sessions.get('ses_does_not_exist').catch((e: unknown) => e)) as APIError;
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(404);
    const unauth = (await new Client({ baseURL, apiKey: 'ak_wrong' }).deployments.list().catch((e: unknown) => e)) as APIError;
    expect(unauth.status).toBe(401);
  });
});
