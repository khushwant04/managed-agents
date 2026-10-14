/**
 * React hooks for @managed-agents/client.
 *
 *     const { events, status, send } = useSession(client, sessionId);
 *
 * Both hooks follow the session's event stream with `client.streamEvents()` and
 * abort it on unmount or when the session changes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Client, Event, InterruptResult, Session, SessionEventResult } from '@managed-agents/client';

export interface UseEventsOptions {
  /** End the stream when the run settles (default `true`). Call `resume()` to follow the next run. */
  untilSettled?: boolean;
  /** Start after this sequence number (default 0: the whole history). */
  after?: number;
  /** Set to `false` to pause streaming (default `true`). */
  enabled?: boolean;
  /** Reconnect attempts after network errors (default 5). */
  retries?: number;
}

export interface UseEventsResult {
  /** Every event received so far, in `seq` order. */
  events: Event[];
  /** The latest `session.status` seen on the stream, if any. */
  status: string | undefined;
  /** `true` once the stream ended (the run settled) or failed. */
  done: boolean;
  /** The error that ended the stream, if any. */
  error: unknown;
  /** Follow the stream again from the last event seen (e.g. after sending a message). */
  resume: () => void;
}

interface StreamState {
  events: Event[];
  done: boolean;
  error: unknown;
}

const initial: StreamState = { events: [], done: false, error: undefined };

/** Follow a session's events. `sessionId` may be `null`/`undefined` while there is none yet. */
export function useEvents(client: Client, sessionId: string | null | undefined, options: UseEventsOptions = {}): UseEventsResult {
  const { untilSettled = true, after = 0, enabled = true, retries } = options;
  const [state, setState] = useState<StreamState>(initial);
  const [generation, setGeneration] = useState(0);
  const cursor = useRef(after);
  const key = useRef<unknown[]>([]);

  useEffect(() => {
    // A different session (or starting point) starts from scratch; `resume()` keeps the cursor.
    const k = [client, sessionId, after];
    if (k.some((v, i) => v !== key.current[i])) {
      key.current = k;
      cursor.current = after;
      setState(initial);
    }
    if (!sessionId || !enabled) return;
    const ac = new AbortController();
    setState((s) => (s.done || s.error !== undefined ? { ...s, done: false, error: undefined } : s));
    void (async () => {
      try {
        for await (const ev of client.streamEvents(sessionId, { after: cursor.current, untilSettled, retries, signal: ac.signal })) {
          if (ac.signal.aborted) return;
          cursor.current = ev.seq;
          setState((s) => ({ ...s, events: [...s.events, ev] }));
        }
        if (!ac.signal.aborted) setState((s) => ({ ...s, done: true }));
      } catch (error) {
        if (!ac.signal.aborted) setState((s) => ({ ...s, done: true, error }));
      }
    })();
    return () => ac.abort();
  }, [client, sessionId, after, untilSettled, enabled, retries, generation]);

  const resume = useCallback(() => setGeneration((g) => g + 1), []);
  const status = useMemo(() => {
    for (let i = state.events.length - 1; i >= 0; i--) {
      const ev = state.events[i]!;
      if (ev.type === 'session.status') return ev.payload.status as string | undefined;
    }
    return undefined;
  }, [state.events]);

  return { events: state.events, status, done: state.done, error: state.error, resume };
}

export interface PendingApproval {
  call_id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface UseSessionResult extends UseEventsResult {
  /** The session record; refreshed whenever a run settles. */
  session: Session | undefined;
  /** `true` until the session record first loads. */
  loading: boolean;
  /** Tool calls waiting for `approve()` / `deny()`. */
  pendingApprovals: PendingApproval[];
  /** Reload the session record. */
  refresh: () => Promise<Session | undefined>;
  /** Send a user message and follow the run it starts. */
  send: (text: string) => Promise<SessionEventResult>;
  approve: (callId: string, reason?: string) => Promise<SessionEventResult>;
  deny: (callId: string, reason?: string) => Promise<SessionEventResult>;
  interrupt: () => Promise<InterruptResult>;
  terminate: () => Promise<void>;
}

/** A session's record, live events and actions. */
export function useSession(client: Client, sessionId: string | null | undefined, options: UseEventsOptions = {}): UseSessionResult {
  const stream = useEvents(client, sessionId, options);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [loadError, setLoadError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(Boolean(sessionId));
  const latest = useRef(sessionId);
  latest.current = sessionId;

  const refresh = useCallback(async () => {
    if (!sessionId) return undefined;
    try {
      const s = await client.sessions.get(sessionId);
      if (latest.current === sessionId) {
        setSession(s);
        setLoadError(undefined);
      }
      return s;
    } catch (err) {
      if (latest.current === sessionId) setLoadError(err);
      return undefined;
    } finally {
      if (latest.current === sessionId) setLoading(false);
    }
  }, [client, sessionId]);

  useEffect(() => {
    setSession(undefined);
    setLoading(Boolean(sessionId));
    void refresh();
  }, [refresh, sessionId]);

  // Reload the record when a run settles (status, last_run, output).
  useEffect(() => {
    if (stream.done) void refresh();
  }, [stream.done, refresh]);

  const { resume } = stream;
  const act = useCallback(
    async <T>(fn: (id: string) => Promise<T>): Promise<T> => {
      if (!sessionId) throw new Error('no session');
      const result = await fn(sessionId);
      resume();
      return result;
    },
    [sessionId, resume],
  );

  const pendingApprovals = useMemo(() => {
    const pending = new Map<string, PendingApproval>();
    for (const ev of stream.events) {
      const callId = ev.payload.call_id as string | undefined;
      if (!callId) continue;
      if (ev.type === 'tool.approval.requested') {
        pending.set(callId, {
          call_id: callId,
          name: String(ev.payload.name ?? ''),
          arguments: (ev.payload.arguments as Record<string, unknown> | undefined) ?? {},
        });
      } else if (ev.type === 'tool.approval.decided') {
        pending.delete(callId);
      }
    }
    return [...pending.values()];
  }, [stream.events]);

  return {
    ...stream,
    error: stream.error ?? loadError,
    status: stream.status ?? session?.status,
    session,
    loading,
    pendingApprovals,
    refresh,
    send: (text) => act((id) => client.sessions.send(id, text)),
    approve: (callId, reason) => act((id) => client.sessions.approve(id, callId, true, reason)),
    deny: (callId, reason) => act((id) => client.sessions.deny(id, callId, reason)),
    interrupt: () => act((id) => client.sessions.interrupt(id)),
    terminate: () => act((id) => client.sessions.terminate(id)),
  };
}
