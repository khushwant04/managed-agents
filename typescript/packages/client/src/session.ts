import type { Client, StreamOptions } from './client.js';
import { toEvent } from './events.js';
import type { Artifact, Event, InterruptResult, Session, SessionEventResult } from './types.js';

/** A hosted session; the same surface as `RemoteSession` in the Python SDK. */
export class RemoteSession {
  readonly client: Client;
  readonly id: string;
  /** The run started by `invoke()`, when this session came from one. */
  readonly runId: string | undefined;
  private _cursor = 0;
  private _info: Session | undefined;

  constructor(client: Client, sessionId: string, runId?: string) {
    this.client = client;
    this.id = sessionId;
    this.runId = runId;
  }

  /** The `seq` of the last event seen by `events()`; the next stream resumes after it. */
  get cursor(): number {
    return this._cursor;
  }

  /**
   * Follow the session's events until the current run settles (idle, waiting for
   * input, waiting for approval, failed) or the session is terminated. Calling it
   * again later continues after the last event seen.
   */
  async *events(options: Omit<StreamOptions, 'after'> = {}): AsyncGenerator<Event, void, undefined> {
    for await (const ev of this.client.streamEvents(this.id, { ...options, after: this._cursor })) {
      this._cursor = ev.seq;
      yield ev;
    }
  }

  /** Stored events after `after` (no streaming). */
  async history(after = 0, limit?: number): Promise<Event[]> {
    const data = await this.client.call('get', '/v1/sessions/{session_id}/events', {
      path: { session_id: this.id },
      query: limit === undefined ? { after } : { after, limit },
    });
    return data.events.map(toEvent);
  }

  send(text: string): Promise<SessionEventResult> {
    return this.client.sessions.send(this.id, text);
  }

  approve(callId: string, approved = true, reason?: string): Promise<SessionEventResult> {
    return this.client.sessions.approve(this.id, callId, approved, reason);
  }

  deny(callId: string, reason?: string): Promise<SessionEventResult> {
    return this.approve(callId, false, reason);
  }

  interrupt(): Promise<InterruptResult> {
    return this.client.sessions.interrupt(this.id);
  }

  /** Terminate the session. */
  close(): Promise<void> {
    return this.client.sessions.terminate(this.id);
  }

  /** Drain `events()` until the run settles, then fetch and return the session. */
  async wait(options: Omit<StreamOptions, 'after'> = {}): Promise<Session> {
    for await (const _ of this.events(options)) {
      // drain
    }
    this._info = await this.client.sessions.get(this.id);
    return this._info;
  }

  /** The last run's output, after `wait()`. */
  get output(): string {
    const run = (this._info?.last_run ?? null) as { output?: string | null } | null;
    return run?.output ?? '';
  }

  artifacts(): Promise<Artifact[]> {
    return this.client.sessions.artifacts(this.id);
  }

  download(artifactId: string): Promise<Uint8Array> {
    return this.client.sessions.download(this.id, artifactId);
  }
}
