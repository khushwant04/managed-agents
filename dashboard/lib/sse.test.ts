import { describe, expect, it } from "vitest";
import { SSEParser, eventFromMessage } from "./sse";

const sample =
  'id: 41\nevent: message.agent.delta\ndata: {"seq":41,"session_id":"ses_1","type":"message.agent.delta","payload":{"text":"Checking"}}\n\n';

describe("SSEParser", () => {
  it("parses a complete message", () => {
    const p = new SSEParser();
    const [m, ...rest] = p.feed(sample);
    expect(rest).toEqual([]);
    expect(m).toMatchObject({ id: "41", event: "message.agent.delta" });
    expect(JSON.parse(m!.data).payload.text).toBe("Checking");
  });

  it("handles messages split at every possible byte boundary", () => {
    const two = sample + sample.replace(/41/g, "42");
    for (let cut = 1; cut < two.length; cut++) {
      const p = new SSEParser();
      const msgs = [...p.feed(two.slice(0, cut)), ...p.feed(two.slice(cut))];
      expect(msgs.map((m) => m.id)).toEqual(["41", "42"]);
    }
  });

  it("supports CRLF and CR line endings, including CRLF split across chunks", () => {
    const p = new SSEParser();
    const msgs = [...p.feed("data: a\r"), ...p.feed("\ndata: b\r\n\r"), ...p.feed("\n"), ...p.feed("data: c\r\r")];
    expect(msgs.map((m) => m.data)).toEqual(["a\nb", "c"]);
  });

  it("ignores comments and keepalives, joins multi-line data, defaults the event name", () => {
    const p = new SSEParser();
    const msgs = p.feed(": keepalive\n\ndata: line1\ndata: line2\n\n");
    expect(msgs).toEqual([{ event: "message", data: "line1\nline2", id: undefined }]);
  });

  it("keeps the last event id across messages and reads retry", () => {
    const p = new SSEParser();
    const msgs = p.feed("id: 7\ndata: x\n\nretry: 3000\ndata: y\n\n");
    expect(msgs[1]).toEqual({ event: "message", data: "y", id: "7", retry: 3000 });
  });

  it("does not dispatch messages without data, strips a BOM, and handles fields without a colon", () => {
    const p = new SSEParser();
    expect(p.feed("﻿event: ping\n\n")).toEqual([]);
    expect(p.feed("data\n\n")).toEqual([{ event: "message", data: "", id: undefined }]);
  });

  it("strips only one leading space from values", () => {
    const p = new SSEParser();
    expect(p.feed("data:  two spaces\n\n")[0]!.data).toBe(" two spaces");
    expect(p.feed("data:none\n\n")[0]!.data).toBe("none");
  });
});

describe("eventFromMessage", () => {
  it("turns a stream message into a typed event", () => {
    const [m] = new SSEParser().feed(sample);
    const ev = eventFromMessage(m!);
    expect(ev).toMatchObject({ seq: 41, type: "message.agent.delta", payload: { text: "Checking" } });
  });

  it("falls back to the SSE event name and id", () => {
    const ev = eventFromMessage({ event: "session.status", data: '{"payload":{"status":"idle"}}', id: "9" });
    expect(ev).toEqual({ id: "seq_9", session_id: "", run_id: null, seq: 9, type: "session.status", ts: "", model: null, payload: { status: "idle" } });
  });

  it("rejects bad JSON and unknown types", () => {
    expect(eventFromMessage({ event: "message", data: "nope", id: undefined })).toBeNull();
    expect(eventFromMessage({ event: "message", data: '{"type":"bogus"}', id: undefined })).toBeNull();
  });
});
