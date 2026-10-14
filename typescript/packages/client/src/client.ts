/**
 * HTTP client for a managed-agents server. Mirrors `agents.client` in the Python SDK.
 *
 *     const client = new Client({ baseURL: 'https://agents.example.com' }); // reads AGENTS_API_KEY
 *     const { version } = await client.agents.register(spec);
 *     await client.agents.promote(spec.name, version);
 *     const session = await client.invoke('incident-investigator@prod', { input: 'Why did p99 jump?' });
 *     for await (const ev of session.events()) { ... }
 *
 * Event streams resume transparently after a dropped connection (`Last-Event-ID`).
 */
import { APIError } from './errors.js';
import { SettleTracker, toEvent } from './events.js';
import type { paths } from './generated/schema.js';
import { Agents, Deployments, Environments, Secrets, Sessions } from './resources.js';
import { RemoteSession } from './session.js';
import { abortError, parseSSE } from './sse.js';
import { encodeSegment } from './util.js';
import type { Event, InvokeAccepted, InvokeResult } from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Server URL. Default: `AGENTS_BASE_URL`, else `http://localhost:8080`. */
  baseURL?: string;
  /** API key sent as `Authorization: Bearer ...`. Default: `AGENTS_API_KEY` (when `process.env` exists). */
  apiKey?: string;
  /** Per-request timeout in milliseconds (default 60 000). For streams it bounds connecting only. */
  timeout?: number;
  /** Extra headers for every request. */
  headers?: Record<string, string>;
  /** A `fetch` implementation (default: the global `fetch`). */
  fetch?: FetchLike;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON body. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Milliseconds; overrides the client's timeout for this call. */
  timeout?: number;
  /** Return the body as bytes (`Uint8Array`) even when it is JSON. */
  raw?: boolean;
}

export interface StreamOptions {
  /** Start after this sequence number (default 0: the whole history). */
  after?: number;
  /** End when the run settles (default `true`). With `false` the stream follows the session until aborted. */
  untilSettled?: boolean;
  /** Reconnect attempts after network errors before giving up (default 5). Reset after every received event. */
  retries?: number;
  /** Delay before reconnect attempt `n` (1-based), in ms. Default `min(500 * 2 ** n, 10_000)`. */
  backoff?: (attempt: number) => number;
  signal?: AbortSignal;
}

export interface InvokeOptions {
  input: string;
  metadata?: Record<string, unknown>;
  /** Invoke through this deployment (`/v1/deployments/{ref}/invoke`) instead of the agent router. */
  deployment?: string;
  signal?: AbortSignal;
}

export interface RunOptions {
  /** How long the server waits for the run, in ms (default 300 000). */
  timeout?: number;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

// -- typed access to every operation of the OpenAPI spec ------------------------------

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
type OperationOf<P extends keyof paths, M extends HttpMethod> = NonNullable<paths[P][M]>;
type JsonContent<R> = R extends { content: { 'application/json': infer J } } ? J : never;
type Successes<O> = O extends { responses: infer R }
  ? { [S in keyof R]: S extends 200 | 201 | 202 ? JsonContent<R[S]> : never }[keyof R]
  : never;
/** The JSON body a successful call returns (`void` for 204-only operations). */
export type ResponseOf<P extends keyof paths, M extends HttpMethod> = [Successes<OperationOf<P, M>>] extends [never]
  ? void
  : Successes<OperationOf<P, M>>;
type BodyOf<O> = O extends { requestBody?: infer RB }
  ? [NonNullable<RB>] extends [never]
    ? never
    : NonNullable<RB> extends { content: { 'application/json': infer B } }
      ? B
      : never
  : never;
type ParamsOf<O, K extends string> = O extends { parameters: infer PS } ? (PS extends { [k in K]?: infer X } ? NonNullable<X> : never) : never;

/** Path params, query and body for one operation, all type-checked against the spec. */
export type CallOptions<P extends keyof paths, M extends HttpMethod> = {
  signal?: AbortSignal;
  timeout?: number;
  headers?: Record<string, string>;
} & ([ParamsOf<OperationOf<P, M>, 'path'>] extends [never] ? { path?: never } : { path: ParamsOf<OperationOf<P, M>, 'path'> }) &
  ([ParamsOf<OperationOf<P, M>, 'query'>] extends [never] ? { query?: never } : { query?: ParamsOf<OperationOf<P, M>, 'query'> }) &
  ([BodyOf<OperationOf<P, M>>] extends [never] ? { body?: never } : { body: BodyOf<OperationOf<P, M>> });

type OperationPaths<M extends HttpMethod> = { [P in keyof paths]: paths[P][M] extends undefined | never ? never : P }[keyof paths];

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return value ? value : undefined;
}

function timeoutError(ms: number): Error {
  const err = new Error(`request timed out after ${ms} ms`);
  err.name = 'TimeoutError';
  return err;
}

/** Combine an optional caller signal with an optional timeout (works without `AbortSignal.any`). */
function deadline(signal: AbortSignal | undefined, ms: number | undefined) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const onAbort = (): void => controller.abort(signal?.reason ?? abortError());
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  if (ms !== undefined && ms > 0 && Number.isFinite(ms)) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError(ms));
    }, ms);
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    /** Stop the timer (e.g. once a stream's headers arrived); the caller's signal stays linked. */
    clearTimer: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function readBody(resp: Response): Promise<unknown> {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal?.reason ?? abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Network-level failures worth a reconnect: fetch's `TypeError`s and our own connect timeout. */
function isNetworkError(err: unknown): boolean {
  if (err instanceof APIError || err instanceof SyntaxError) return false;
  if (err instanceof TypeError) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || typeof (err as { code?: unknown } | null)?.code === 'string';
}

export const defaultBackoff = (attempt: number): number => Math.min(500 * 2 ** attempt, 10_000);

export class Client {
  readonly baseURL: string;
  readonly timeout: number;
  readonly agents: Agents;
  readonly deployments: Deployments;
  readonly sessions: Sessions;
  readonly secrets: Secrets;
  readonly environments: Environments;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(options: ClientOptions = {}) {
    this.baseURL = (options.baseURL || env('AGENTS_BASE_URL') || 'http://localhost:8080').replace(/\/+$/, '');
    this.timeout = options.timeout ?? 60_000;
    const key = options.apiKey ?? env('AGENTS_API_KEY');
    this.headers = { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...options.headers };
    const f = options.fetch;
    if (f) this.fetchImpl = f;
    else if (typeof globalThis.fetch === 'function') this.fetchImpl = (input, init) => globalThis.fetch(input, init);
    else throw new Error('no global fetch: use Node 18+ or pass options.fetch');
    this.agents = new Agents(this);
    this.deployments = new Deployments(this);
    this.sessions = new Sessions(this);
    this.secrets = new Secrets(this);
    this.environments = new Environments(this);
  }

  /** Absolute URL for `path` plus query parameters (`null`/`undefined` values are dropped). */
  url(path: string, query?: RequestOptions['query']): string {
    let url = this.baseURL + (path.startsWith('/') ? path : `/${path}`);
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) params.append(k, String(v));
      const qs = params.toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    return url;
  }

  /**
   * Low-level request. Returns parsed JSON for JSON responses, `undefined` for 204 or
   * an empty body, and the raw bytes (`Uint8Array`) otherwise (or always, with `raw`).
   * Throws `APIError` for 4xx/5xx.
   */
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const d = deadline(options.signal, options.timeout ?? this.timeout);
    const headers: Record<string, string> = { Accept: 'application/json', ...this.headers, ...options.headers };
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] ??= 'application/json';
    }
    try {
      const resp = await this.fetchImpl(this.url(path, options.query), { method: method.toUpperCase(), headers, body, signal: d.signal });
      if (resp.status >= 400) throw new APIError(resp.status, await readBody(resp));
      if (resp.status === 204) return undefined as T;
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.byteLength === 0) return undefined as T;
      if (!options.raw && (resp.headers.get('content-type') ?? '').startsWith('application/json')) {
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
      }
      return bytes as T;
    } finally {
      d.dispose();
    }
  }

  /**
   * Call any operation of the API, with path, query, body and result typed from the
   * generated OpenAPI types:
   *
   *     const usage = await client.call('get', '/v1/usage', { query: { days: 7 } });
   */
  async call<M extends HttpMethod, P extends OperationPaths<M>>(method: M, path: P, options?: CallOptions<P, M>): Promise<ResponseOf<P, M>> {
    const o = (options ?? {}) as { path?: Record<string, string | number>; query?: RequestOptions['query']; body?: unknown } & RequestOptions;
    const resolved = (path as string).replace(/\{([^}]+)\}/g, (_, name: string) => {
      const v = o.path?.[name];
      if (v === undefined) throw new TypeError(`missing path parameter ${name} for ${path as string}`);
      return encodeSegment(v);
    });
    return this.request<ResponseOf<P, M>>(method, resolved, { query: o.query, body: o.body, signal: o.signal, timeout: o.timeout, headers: o.headers });
  }

  /** Start a session through the router (or a deployment) and return at once; follow it with `events()`. */
  async invoke(target: string, options: InvokeOptions | string): Promise<RemoteSession> {
    const o: InvokeOptions = typeof options === 'string' ? { input: options } : options;
    const body = { input: o.input, mode: 'async' as const, metadata: o.metadata ?? {} };
    const data = (
      o.deployment
        ? await this.call('post', '/v1/deployments/{ref}/invoke', { path: { ref: o.deployment }, body, signal: o.signal })
        : await this.call('post', '/v1/agents/{target}/invoke', { path: { target }, body, signal: o.signal })
    ) as InvokeAccepted;
    return new RemoteSession(this, data.session_id, data.run_id);
  }

  /** Invoke and wait for the run to finish (`mode: "sync"`); returns output, stop reason and usage. */
  async run(target: string, input: string, options: RunOptions = {}): Promise<InvokeResult> {
    const timeout = options.timeout ?? 300_000;
    const body: Record<string, unknown> = { input, mode: 'sync', wait_timeout: timeout / 1000 };
    if (options.metadata) body.metadata = options.metadata;
    return (await this.call('post', '/v1/agents/{target}/invoke', {
      path: { target },
      body: body as { input: string },
      timeout: timeout + 30_000,
      signal: options.signal,
    })) as InvokeResult;
  }

  /**
   * Follow a session's event stream (SSE), reconnecting with `Last-Event-ID` after
   * network errors. With `untilSettled` (the default) it ends when the run settles.
   */
  async *streamEvents(sessionId: string, options: StreamOptions = {}): AsyncGenerator<Event, void, undefined> {
    const untilSettled = options.untilSettled ?? true;
    const retries = options.retries ?? 5;
    const backoff = options.backoff ?? defaultBackoff;
    const signal = options.signal;
    const settle = new SettleTracker();
    let last = options.after ?? 0;
    let attempt = 0;
    while (true) {
      if (signal?.aborted) throw signal.reason ?? abortError();
      const d = deadline(signal, this.timeout);
      try {
        const resp = await this.fetchImpl(this.url(`/v1/sessions/${encodeSegment(sessionId)}/stream`, { until_settled: untilSettled ? 'true' : 'false' }), {
          method: 'GET',
          headers: { ...this.headers, Accept: 'text/event-stream', 'Last-Event-ID': String(last) },
          signal: d.signal,
        });
        d.clearTimer(); // the timeout bounds connecting; an idle stream may stay open
        if (resp.status >= 400) throw new APIError(resp.status, await readBody(resp));
        if (!resp.body) throw new TypeError('stream response has no body');
        for await (const msg of parseSSE(resp.body, d.signal)) {
          const ev = toEvent(JSON.parse(msg.data));
          attempt = 0;
          last = ev.seq;
          yield ev;
          if (untilSettled && settle.observe(ev)) return;
        }
        if (untilSettled) return;
      } catch (err) {
        if (signal?.aborted) throw err;
        if (!isNetworkError(err) && !d.timedOut()) throw err;
        attempt += 1;
        if (attempt > retries) throw err;
        await sleep(backoff(attempt), signal);
      } finally {
        d.dispose();
      }
    }
  }
}
