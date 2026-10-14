import type { FetchLike } from '../src/index.js';

export interface Recorded {
  method: string;
  url: URL;
  path: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | undefined;
}

export type Handler = (req: Recorded, index: number) => Response | Promise<Response>;

/** A `fetch` that records every request and answers with `handler`. */
export function mockFetch(handler: Handler): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const raw = init.body;
    const rec: Recorded = {
      method: init.method ?? 'GET',
      url,
      path: url.pathname,
      headers: new Headers(init.headers),
      body: typeof raw === 'string' ? JSON.parse(raw) : raw,
      signal: init.signal ?? undefined,
    };
    calls.push(rec);
    if (rec.signal?.aborted) throw rec.signal.reason;
    return handler(rec, calls.length - 1);
  };
  return { fetch, calls };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let n = 0;

/** A wire event as the server sends it. */
export function wire(seq: number, type: string, payload: Record<string, unknown> = {}, session = 'ses_1'): Record<string, unknown> {
  return { id: `evt_${++n}`, session_id: session, run_id: 'run_1', seq, type, ts: '2026-10-14T00:00:00Z', model: null, payload };
}

/** One SSE frame, exactly as `Event.to_sse()` renders it on the server. */
export function frame(ev: Record<string, unknown>): string {
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/**
 * A streaming `text/event-stream` response. `fail` makes the body error after the
 * chunks (a dropped connection); `hang` keeps it open until the request is aborted.
 */
export function sseResponse(chunks: string[], opts: { fail?: boolean; hang?: boolean; signal?: AbortSignal } = {}): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (opts.hang) opts.signal?.addEventListener('abort', () => controller.error(opts.signal?.reason));
    },
    // Deliver one chunk per read so a failure happens only after everything before it was read.
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else if (opts.fail) controller.error(new TypeError('terminated'));
      else if (!opts.hang) controller.close();
      else return new Promise<void>(() => undefined);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export const status = (seq: number, s: string): Record<string, unknown> => wire(seq, 'session.status', { status: s });
