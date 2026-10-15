import { describe, expect, it } from 'vitest';
import { APIError, Client, SettleTracker, toEvent, type Event } from '../src/index.js';
import { frame, json, mockFetch, sseResponse, status, wire } from './helpers.js';

const noDelay = () => 0;

async function collect(it: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe('toEvent', () => {
  it('adds text from payload.text and keeps the wire fields', () => {
    const raw = wire(4, 'message.agent.delta', { text: 'hi' });
    expect(toEvent(raw)).toEqual({ ...raw, text: 'hi' });
    expect(toEvent(wire(5, 'run.started')).text).toBe('');
    expect(toEvent(wire(6, 'run.started', { text: 3 })).text).toBe('3');
    expect(() => toEvent('nope')).toThrow(TypeError);
  });
});

describe('SettleTracker', () => {
  const s = (status: string) => ({ type: 'session.status' as const, payload: { status } });
  const other = { type: 'run.started' as const, payload: {} };

  it('ignores a settled status before anything ran', () => {
    const t = new SettleTracker();
    expect(t.observe(s('idle'))).toBe(false);
    expect(t.observe(s('running'))).toBe(false);
    expect(t.observe(s('idle'))).toBe(true);
  });

  it.each(['idle', 'waiting_input', 'approval_pending', 'failed'])('stops on %s after run activity', (st) => {
    const t = new SettleTracker();
    t.observe(other);
    expect(t.observe(s(st))).toBe(true);
  });

  it('stops on terminated at any time and treats queued as running', () => {
    expect(new SettleTracker().observe(s('terminated'))).toBe(true);
    const t = new SettleTracker();
    expect(t.observe(s('queued'))).toBe(false);
    expect(t.observe(s('waiting_input'))).toBe(true);
  });
});

describe('streamEvents', () => {
  it('follows SSE until the run settles and sends auth, Accept and Last-Event-ID', async () => {
    const events = [status(1, 'idle'), status(2, 'running'), wire(3, 'message.agent.delta', { text: 'he' }), wire(4, 'message.agent.delta', { text: 'y' }), status(5, 'idle'), wire(6, 'run.started')];
    const { fetch, calls } = mockFetch(() => sseResponse(events.map(frame)));
    const client = new Client({ baseURL: 'http://x/', apiKey: 'ak_1', fetch });
    const got = await collect(client.streamEvents('ses_1'));
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(got.filter((e) => e.type === 'message.agent.delta').map((e) => e.text).join('')).toBe('hey');
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.url.toString()).toBe('http://x/v1/sessions/ses_1/stream?until_settled=true');
    expect(req.headers.get('authorization')).toBe('Bearer ak_1');
    expect(req.headers.get('accept')).toBe('text/event-stream');
    expect(req.headers.get('last-event-id')).toBe('0');
  });

  it('reconnects with Last-Event-ID after a dropped connection', async () => {
    const all = [status(1, 'running'), wire(2, 'message.agent.delta', { text: 'a' }), wire(3, 'message.agent.delta', { text: 'b' }), status(4, 'idle')];
    const { fetch, calls } = mockFetch((req, i) => {
      if (i === 0) return sseResponse([frame(all[0]!), frame(all[1]!), 'id: 3\ndata: {"partial'], { fail: true });
      if (i === 1) throw new TypeError('fetch failed'); // connection refused while the server restarts
      const after = Number(req.headers.get('last-event-id'));
      return sseResponse(all.filter((e) => (e.seq as number) > after).map(frame));
    });
    const client = new Client({ baseURL: 'http://x', fetch });
    const got = await collect(client.streamEvents('ses_1', { backoff: noDelay }));
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(calls.map((c) => c.headers.get('last-event-id'))).toEqual(['0', '2', '2']);
  });

  it('gives up after the configured retries', async () => {
    const delays: number[] = [];
    const { fetch, calls } = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const client = new Client({ baseURL: 'http://x', fetch });
    await expect(collect(client.streamEvents('ses_1', { retries: 3, backoff: (n) => (delays.push(n), 0) }))).rejects.toThrow('fetch failed');
    expect(calls).toHaveLength(4);
    expect(delays).toEqual([1, 2, 3]);
  });

  it('resets the retry budget after each received event', async () => {
    const { fetch, calls } = mockFetch((_, i) => (i < 4 ? sseResponse([frame(wire(i + 1, 'tool.call'))], { fail: true }) : sseResponse([frame(status(5, 'idle'))])));
    const client = new Client({ baseURL: 'http://x', fetch });
    const got = await collect(client.streamEvents('ses_1', { retries: 1, backoff: noDelay }));
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toHaveLength(5);
  });

  it('raises APIError without retrying for HTTP errors', async () => {
    const { fetch, calls } = mockFetch(() => json({ error: 'not_found', message: 'unknown session' }, 404));
    const client = new Client({ baseURL: 'http://x', fetch });
    const err = await collect(client.streamEvents('nope', { backoff: noDelay })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it('does not retry malformed event data', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse(['data: not json\n\n']));
    const client = new Client({ baseURL: 'http://x', fetch });
    await expect(collect(client.streamEvents('s', { backoff: noDelay }))).rejects.toBeInstanceOf(SyntaxError);
    expect(calls).toHaveLength(1);
  });

  it('stops when the caller aborts, without reconnecting', async () => {
    const ac = new AbortController();
    const { fetch, calls } = mockFetch((req) => sseResponse([frame(status(1, 'running'))], { hang: true, signal: req.signal }));
    const client = new Client({ baseURL: 'http://x', fetch });
    const seen: number[] = [];
    await expect(async () => {
      for await (const ev of client.streamEvents('s', { signal: ac.signal, backoff: noDelay })) {
        seen.push(ev.seq);
        setTimeout(() => ac.abort(), 5);
      }
    }).rejects.toThrow();
    expect(seen).toEqual([1]);
    expect(calls).toHaveLength(1);
  });

  it('with untilSettled=false keeps following past settled statuses', async () => {
    const { fetch, calls } = mockFetch((_, i) => (i === 0 ? sseResponse([frame(status(1, 'running')), frame(status(2, 'idle')), frame(wire(3, 'run.started'))]) : sseResponse([frame(status(4, 'terminated'))], { hang: true })));
    const client = new Client({ baseURL: 'http://x', fetch });
    const seen: number[] = [];
    for await (const ev of client.streamEvents('s', { untilSettled: false })) {
      seen.push(ev.seq);
      if (ev.seq === 4) break;
    }
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(calls[0]!.url.searchParams.get('until_settled')).toBe('false');
    expect(calls[1]!.headers.get('last-event-id')).toBe('3');
  });
});

describe('invoke + RemoteSession', () => {
  it('runs the documented example and resumes from the cursor on the next run', async () => {
    const run1 = [wire(1, 'route.resolved'), status(2, 'running'), wire(3, 'message.agent.delta', { text: 'Triaged ' }), wire(4, 'message.agent.delta', { text: '3 alerts' }), status(5, 'idle')];
    const run2 = [wire(6, 'message.user', { text: 'more' }), wire(7, 'message.agent.delta', { text: 'ok' }), status(8, 'waiting_input')];
    const { fetch, calls } = mockFetch((req) => {
      if (req.path === '/v1/agents/incident-investigator@prod/invoke') return json({ session_id: 'ses_9', run_id: 'run_9', agent: 'incident-investigator', alias: 'prod', version: 3 }, 202);
      if (req.path === '/v1/sessions/ses_9/events' && req.method === 'POST') return json({ run_id: 'run_10' });
      if (req.path === '/v1/sessions/ses_9/stream') {
        const after = Number(req.headers.get('last-event-id'));
        return sseResponse([...run1, ...run2].filter((e) => (e.seq as number) > after && (after >= 5 || (e.seq as number) <= 5)).map(frame));
      }
      if (req.path === '/v1/sessions/ses_9') return json({ id: 'ses_9', status: 'waiting_input', last_run: { id: 'run_10', status: 'finished', output: 'ok' } });
      return json({ error: 'not_found' }, 404);
    });
    const client = new Client({ baseURL: 'https://runhive.example.com', fetch });
    const session = await client.invoke('incident-investigator@prod', { input: 'Triage new alerts' });
    expect(calls[0]!.body).toEqual({ input: 'Triage new alerts', mode: 'async', metadata: {} });
    expect(session.id).toBe('ses_9');
    expect(session.runId).toBe('run_9');
    let out = '';
    for await (const ev of session.events()) {
      if (ev.type === 'message.agent.delta') out += ev.text;
    }
    expect(out).toBe('Triaged 3 alerts');
    expect(session.cursor).toBe(5);
    await session.send('more');
    const info = await session.wait();
    expect(info.status).toBe('waiting_input');
    expect(session.output).toBe('ok');
    expect(session.cursor).toBe(8);
    expect(calls.filter((c) => c.path.endsWith('/stream')).map((c) => c.headers.get('last-event-id'))).toEqual(['0', '5']);
  });
});
