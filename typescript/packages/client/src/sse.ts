/**
 * A small `text/event-stream` parser that follows the WHATWG server-sent events
 * algorithm: `id:`, `event:`, `retry:` and multi-line `data:` fields, `:` comments,
 * and CRLF, LF or CR line endings (including a CRLF split across chunks).
 *
 * It works on any `ReadableStream<Uint8Array>` (fetch response bodies in Node 18+
 * and browsers) and has no dependencies.
 */

export interface SSEMessage {
  /** The `event:` field, or `"message"` when absent. */
  event: string;
  /** The `data:` lines joined with `\n`. */
  data: string;
  /** The last `id:` seen on the stream so far (the "last event ID"), or `undefined`. */
  id: string | undefined;
  /** The `retry:` field of this message, in milliseconds, when present. */
  retry?: number;
}

/** Incremental parser: `feed()` text as it arrives, collect complete messages. */
export class SSEParser {
  private buffer = '';
  private data: string[] = [];
  private hasData = false;
  private eventType = '';
  private lastId: string | undefined;
  private retry: number | undefined;
  private pendingCR = false;
  private started = false;

  /** Feed decoded text; returns the messages completed by it. */
  feed(chunk: string): SSEMessage[] {
    if (!this.started && chunk.length) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    // A CR that ended the previous chunk already terminated a line; drop the LF that may follow it.
    if (this.pendingCR) {
      this.pendingCR = false;
      if (chunk.startsWith('\n')) chunk = chunk.slice(1);
    }
    this.buffer += chunk;
    const out: SSEMessage[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      const line = this.buffer.slice(start, i);
      if (c === 13) {
        if (i + 1 < this.buffer.length) {
          if (this.buffer.charCodeAt(i + 1) === 10) i++;
        } else {
          this.pendingCR = true;
        }
      }
      start = i + 1;
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /**
   * End of stream. Per the spec an unterminated final message is discarded, so a
   * connection that drops mid-event never yields half a JSON document.
   */
  end(): SSEMessage[] {
    this.buffer = '';
    this.data = [];
    this.hasData = false;
    this.eventType = '';
    return [];
  }

  /** The last event ID seen, used for `Last-Event-ID` on reconnect. */
  get lastEventId(): string | undefined {
    return this.lastId;
  }

  private line(line: string): SSEMessage | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined; // comment / keepalive
    const colon = line.indexOf(':');
    let field = line;
    let value = '';
    if (colon !== -1) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    switch (field) {
      case 'data':
        this.data.push(value);
        this.hasData = true;
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        if (!value.includes('\0')) this.lastId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break; // unknown fields are ignored
    }
    return undefined;
  }

  private dispatch(): SSEMessage | undefined {
    const retry = this.retry;
    this.retry = undefined;
    if (!this.hasData) {
      this.eventType = '';
      return undefined;
    }
    const msg: SSEMessage = { event: this.eventType || 'message', data: this.data.join('\n'), id: this.lastId };
    if (retry !== undefined) msg.retry = retry;
    this.data = [];
    this.hasData = false;
    this.eventType = '';
    return msg;
  }
}

/**
 * Parse a byte stream into SSE messages. Cancels the underlying stream when the
 * consumer stops early (`break`, `return`) or `signal` aborts.
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SSEMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SSEParser();
  const onAbort = (): void => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let done = false;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? abortError();
      const r = await reader.read();
      if (r.done) {
        done = true;
        if (signal?.aborted) throw signal.reason ?? abortError();
        yield* parser.feed(decoder.decode());
        parser.end();
        return;
      }
      yield* parser.feed(decoder.decode(r.value, { stream: true }));
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!done) await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

export function abortError(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}
