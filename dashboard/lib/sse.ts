/**
 * Incremental Server-Sent Events parser (WHATWG "event stream interpretation").
 *
 * Feed it decoded text in whatever chunks the network delivers; it returns the
 * messages completed by that chunk. Lines may end in LF, CRLF or CR, and a CRLF
 * split across two chunks is handled.
 */
import type { ApiEvent } from "./api";
import { isEventType } from "./api";

export interface SSEMessage {
  /** The `event:` field, or "message" when absent. */
  event: string;
  /** All `data:` lines joined with "\n". */
  data: string;
  /** The last event ID seen on the stream (sticky across messages, per spec). */
  id: string | undefined;
  /** A `retry:` value in milliseconds, when one arrived with this message. */
  retry?: number;
}

export class SSEParser {
  private buffer = "";
  private data: string[] = [];
  private eventName = "";
  private lastId: string | undefined;
  private retry: number | undefined;
  private sawCR = false;
  private started = false;

  /** Feed a chunk of decoded text; returns any messages it completed. */
  feed(chunk: string): SSEMessage[] {
    if (!this.started && chunk.length > 0) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    // A CR at the end of the previous chunk already ended a line; drop the LF of its CRLF.
    if (this.sawCR && chunk.startsWith("\n")) chunk = chunk.slice(1);
    this.sawCR = false;

    const out: SSEMessage[] = [];
    let text = this.buffer + chunk;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c !== "\n" && c !== "\r") continue;
      this.line(text.slice(start, i), out);
      if (c === "\r") {
        if (i + 1 < text.length) {
          if (text[i + 1] === "\n") i++;
        } else {
          this.sawCR = true;
        }
      }
      start = i + 1;
    }
    text = text.slice(start);
    this.buffer = text;
    return out;
  }

  /** Flush at end of stream. Per spec an unterminated final message is discarded. */
  end(): SSEMessage[] {
    this.buffer = "";
    this.data = [];
    this.eventName = "";
    return [];
  }

  private line(line: string, out: SSEMessage[]): void {
    if (line === "") {
      this.dispatch(out);
      return;
    }
    if (line.startsWith(":")) return; // comment / keepalive
    const colon = line.indexOf(":");
    let field = line;
    let value = "";
    if (colon >= 0) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.lastId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break; // unknown fields are ignored
    }
  }

  private dispatch(out: SSEMessage[]): void {
    if (this.data.length === 0) {
      this.eventName = "";
      return;
    }
    const msg: SSEMessage = { event: this.eventName || "message", data: this.data.join("\n"), id: this.lastId };
    if (this.retry !== undefined) msg.retry = this.retry;
    out.push(msg);
    this.data = [];
    this.eventName = "";
    this.retry = undefined;
  }
}

/** Parse the JSON body of a session-stream message into an event; null when it is not one. */
export function eventFromMessage(msg: SSEMessage): ApiEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(msg.data);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const ev = body as Partial<ApiEvent>;
  const type = ev.type ?? msg.event;
  if (!isEventType(type)) return null;
  let seq = typeof ev.seq === "number" ? ev.seq : undefined;
  if (seq === undefined && msg.id !== undefined && /^\d+$/.test(msg.id)) seq = Number(msg.id);
  return {
    ...ev,
    session_id: ev.session_id ?? "",
    type,
    seq: seq ?? 0,
    payload: ev.payload ?? {},
  } as ApiEvent;
}
