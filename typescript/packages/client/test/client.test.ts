import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIError, Client } from '../src/index.js';
import { json, mockFetch } from './helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('APIError mapping', () => {
  it.each([
    [{ error: 'not_found', message: 'unknown session ses_x' }, 404, '404: unknown session ses_x', [], 'not_found'],
    [{ error: 'invalid_definition', problems: ['unknown model nope-model', 'tool f has no url'] }, 422, '422: invalid_definition (unknown model nope-model; tool f has no url)', ['unknown model nope-model', 'tool f has no url'], 'invalid_definition'],
    [{ error: 'unauthorized', message: 'missing bearer API key' }, 401, '401: missing bearer API key', [], 'unauthorized'],
    [{ error: 'invalid_request', message: 'invalid request body', problems: ['body.input: Field required'] }, 422, '422: invalid request body (body.input: Field required)', ['body.input: Field required'], 'invalid_request'],
    [{ error: 'conflict', message: null, problems: null }, 409, '409: conflict', [], 'conflict'],
  ])('maps ErrorBody %j', async (body, code, message, problems, errorCode) => {
    const { fetch } = mockFetch(() => json(body, code));
    const err = (await new Client({ fetch }).sessions.get('ses_x').catch((e: unknown) => e)) as APIError;
    expect(err).toBeInstanceOf(APIError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('APIError');
    expect(err.status).toBe(code);
    expect(err.body).toEqual(body);
    expect(err.message).toBe(message);
    expect(err.problems).toEqual(problems);
    expect(err.code).toBe(errorCode);
    expect(err.error).toEqual(body);
  });

  it('keeps JSON bodies that are not an ErrorBody', async () => {
    const { fetch } = mockFetch(() => json({ upstream: 'down' }, 503));
    const err = (await new Client({ fetch }).deployments.list().catch((e: unknown) => e)) as APIError;
    expect(err.message).toBe('503: {"upstream":"down"}');
    expect(err.error).toBeUndefined();
    expect(err.body).toEqual({ upstream: 'down' });
  });

  it('keeps non-JSON error bodies as text', async () => {
    const { fetch } = mockFetch(() => new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } }));
    const err = (await new Client({ fetch }).deployments.list().catch((e: unknown) => e)) as APIError;
    expect(err.status).toBe(502);
    expect(err.body).toBe('Bad Gateway');
    expect(err.message).toBe('502: Bad Gateway');
    expect(err.problems).toEqual([]);
    expect(err.error).toBeUndefined();
  });
});

describe('request()', () => {
  it('returns undefined for 204 and empty bodies, bytes for non-JSON', async () => {
    const { fetch } = mockFetch((req) => {
      if (req.path === '/a') return new Response(null, { status: 204 });
      if (req.path === '/b') return new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });
    const c = new Client({ fetch });
    expect(await c.request('DELETE', '/a')).toBeUndefined();
    expect(await c.request('GET', '/b')).toBeUndefined();
    expect(await c.request('GET', '/c')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('times out', async () => {
    const fetch = (_: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    await expect(new Client({ fetch, timeout: 20 }).request('GET', '/slow')).rejects.toThrow('timed out after 20 ms');
  });

  it('honours a caller AbortSignal', async () => {
    const fetch = (_: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const ac = new AbortController();
    const p = new Client({ fetch }).request('GET', '/slow', { signal: ac.signal });
    ac.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
  });
});

describe('configuration', () => {
  it('reads AGENTS_BASE_URL and AGENTS_API_KEY', async () => {
    vi.stubEnv('AGENTS_BASE_URL', 'https://env.example.com/');
    vi.stubEnv('AGENTS_API_KEY', 'ak_env');
    const { fetch, calls } = mockFetch(() => json({ deployments: [] }));
    const c = new Client({ fetch });
    expect(c.baseURL).toBe('https://env.example.com');
    await c.deployments.list();
    expect(calls[0]!.url.toString()).toBe('https://env.example.com/v1/deployments');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer ak_env');
  });

  it('defaults to localhost:8080 without a key, and explicit options win', async () => {
    vi.stubEnv('AGENTS_BASE_URL', '');
    vi.stubEnv('AGENTS_API_KEY', '');
    const { fetch, calls } = mockFetch(() => json({ secrets: [] }));
    const c = new Client({ fetch });
    expect(c.baseURL).toBe('http://localhost:8080');
    await c.secrets.list();
    expect(calls[0]!.headers.has('authorization')).toBe(false);
    vi.stubEnv('AGENTS_API_KEY', 'ak_env');
    await new Client({ fetch, apiKey: 'ak_explicit', headers: { 'X-Trace': '1' } }).secrets.list();
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer ak_explicit');
    expect(calls[1]!.headers.get('x-trace')).toBe('1');
  });

  it('works without process (browsers)', () => {
    const saved = globalThis.process;
    // @ts-expect-error simulate a browser
    delete globalThis.process;
    try {
      expect(new Client({ fetch: async () => json({}) }).baseURL).toBe('http://localhost:8080');
    } finally {
      globalThis.process = saved;
    }
  });
});
