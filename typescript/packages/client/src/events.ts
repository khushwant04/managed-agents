import type { Event, EventType, Schemas, SessionStatus } from './types.js';

/** All event types, in the order the server defines them. */
export const EVENT_TYPES: readonly EventType[] = [
  'session.status',
  'route.resolved',
  'run.started',
  'run.finished',
  'message.user',
  'message.agent.delta',
  'message.agent.done',
  'thinking.delta',
  'tool.call',
  'tool.result',
  'tool.approval.requested',
  'tool.approval.decided',
  'subagent.started',
  'subagent.finished',
  'artifact.created',
  'error',
] as const;

/** Statuses at which a run has stopped and a session waits (or is gone). */
export const SETTLED_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'idle',
  'waiting_input',
  'approval_pending',
  'failed',
  'terminated',
]);

/** Build an `Event` from its JSON form, adding `text` (`payload.text ?? ''`). */
export function toEvent(raw: unknown): Event {
  if (raw === null || typeof raw !== 'object') throw new TypeError(`not an event: ${JSON.stringify(raw)}`);
  const ev = raw as Schemas['Event'];
  const text = ev.payload?.text;
  return { ...ev, text: text === undefined || text === null ? '' : String(text) };
}

/**
 * Tracks whether a run has been seen and whether the stream should stop.
 * Same rule as the Python `AsyncClient.stream_events` and the server's SSE endpoint:
 * any non-status event or a `queued`/`running` status marks the session running;
 * a settled status after that, or `terminated` at any time, ends the stream.
 */
export class SettleTracker {
  running = false;

  /** Returns `true` when the stream should end after `ev`. */
  observe(ev: Pick<Event, 'type' | 'payload'>): boolean {
    if (ev.type !== 'session.status') {
      this.running = true;
      return false;
    }
    const status = ev.payload.status as string | undefined;
    if (status === 'queued' || status === 'running') {
      this.running = true;
      return false;
    }
    if (status === 'terminated') return true;
    return this.running && status !== undefined && SETTLED_STATUSES.has(status as SessionStatus);
  }
}
