import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { Client } from '@managed-agents/client';
import { useEvents, useSession } from '../src/index.js';

type Wire = Record<string, unknown>;
const ev = (seq: number, type: string, payload: Record<string, unknown> = {}): Wire => ({ id: `e${seq}`, session_id: 'ses_1', run_id: 'r', seq, type, ts: '', model: null, payload });
const frame = (e: Wire) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/** A fake server: a growing event log served over SSE, plus the session endpoints. */
function fakeServer(log: Wire[]) {
  const streams: string[] = [];
  const posts: unknown[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/stream')) {
      const after = Number(new Headers(init.headers).get('last-event-id'));
      streams.push(String(after));
      const body = log.filter((e) => (e.seq as number) > after).map(frame).join('');
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (init.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ run_id: 'r2' });
    }
    const last = [...log].reverse().find((e) => e.type === 'session.status');
    return Response.json({ id: 'ses_1', status: (last?.payload as { status?: string } | undefined)?.status ?? 'queued' });
  };
  return { client: new Client({ baseURL: 'http://x', fetch }), streams, posts };
}

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

describe('useEvents', () => {
  it('collects events until the run settles', async () => {
    const { client } = fakeServer([ev(1, 'session.status', { status: 'running' }), ev(2, 'message.agent.delta', { text: 'po' }), ev(3, 'message.agent.delta', { text: 'ng' }), ev(4, 'session.status', { status: 'idle' })]);
    const { result } = renderHook(() => useEvents(client, 'ses_1'), { wrapper: strict });
    await waitFor(() => expect(result.current.done).toBe(true));
    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(result.current.events.map((e) => e.text).join('')).toBe('pong');
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeUndefined();
  });

  it('does nothing without a session id', () => {
    const { client, streams } = fakeServer([]);
    const { result } = renderHook(() => useEvents(client, null));
    expect(result.current.events).toEqual([]);
    expect(streams).toEqual([]);
  });

  it('reports stream errors', async () => {
    const client = new Client({ baseURL: 'http://x', fetch: async () => Response.json({ error: 'not_found', message: 'no session' }, { status: 404 }) });
    const { result } = renderHook(() => useEvents(client, 'ses_x'));
    await waitFor(() => expect(result.current.done).toBe(true));
    expect(String(result.current.error)).toContain('404: no session');
  });
});

describe('useSession', () => {
  it('loads the session, sends input and follows the next run from the cursor', async () => {
    const log = [ev(1, 'session.status', { status: 'running' }), ev(2, 'tool.approval.requested', { call_id: 'c1', name: 'deploy', arguments: { env: 'prod' } }), ev(3, 'session.status', { status: 'approval_pending' })];
    const { client, streams, posts } = fakeServer(log);
    const { result } = renderHook(() => useSession(client, 'ses_1'));
    await waitFor(() => expect(result.current.done).toBe(true));
    await waitFor(() => expect(result.current.session?.status).toBe('approval_pending'));
    expect(result.current.loading).toBe(false);
    expect(result.current.pendingApprovals).toEqual([{ call_id: 'c1', name: 'deploy', arguments: { env: 'prod' } }]);

    log.push(ev(4, 'tool.approval.decided', { call_id: 'c1', approved: true }), ev(5, 'session.status', { status: 'running' }), ev(6, 'message.agent.delta', { text: 'done' }), ev(7, 'session.status', { status: 'idle' }));
    await act(async () => {
      await result.current.approve('c1');
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    await waitFor(() => expect(result.current.session?.status).toBe('idle'));
    expect(posts).toEqual([{ type: 'tool.approval.decided', call_id: 'c1', approved: true, reason: null }]);
    expect(result.current.pendingApprovals).toEqual([]);
    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(streams).toEqual(['0', '3']);
  });
});
