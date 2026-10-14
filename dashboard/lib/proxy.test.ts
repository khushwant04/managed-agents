import { describe, expect, it } from "vitest";
import { SSE_PREAMBLE, isSameOrigin, prependChunk, normalizeBaseUrl, parseProjectCookie, pickHeaders, resolveUpstream, upstreamConfig, upstreamUrl } from "./proxy";

describe("upstream configuration", () => {
  it("normalises base URLs and rejects unsafe ones", () => {
    expect(normalizeBaseUrl("https://agents.example.com/")).toBe("https://agents.example.com");
    expect(normalizeBaseUrl("http://localhost:8080/api//")).toBe("http://localhost:8080/api");
    expect(normalizeBaseUrl("ftp://x")).toBeNull();
    expect(normalizeBaseUrl("https://user:pw@x.com")).toBeNull();
    expect(normalizeBaseUrl("https://x.com/?a=1")).toBeNull();
    expect(normalizeBaseUrl("not a url")).toBeNull();
  });

  it("defaults to AGENTS_API_URL and only allows listed overrides", () => {
    const cfg = upstreamConfig({ AGENTS_API_URL: "http://api:8080/", AGENTS_API_URL_ALLOWLIST: "https://staging.example.com, bogus, http://api:8080" });
    expect(cfg).toEqual({ defaultUrl: "http://api:8080", allowed: ["http://api:8080", "https://staging.example.com"] });
    expect(resolveUpstream(cfg, "")).toBe("http://api:8080");
    expect(resolveUpstream(cfg, null)).toBe("http://api:8080");
    expect(resolveUpstream(cfg, "https://staging.example.com/")).toBe("https://staging.example.com");
    expect(resolveUpstream(cfg, "https://evil.example.com")).toBeNull();
    expect(upstreamConfig({}).defaultUrl).toBe("http://localhost:8080");
  });
});

describe("upstreamUrl", () => {
  const base = "http://api:8080";
  it("maps /v1 paths and keeps the query string", () => {
    expect(upstreamUrl(base, ["v1", "agents"], "?q=bot")).toBe("http://api:8080/v1/agents?q=bot");
    expect(upstreamUrl(base, ["v1", "agents", "bot@prod", "card"], "")).toBe("http://api:8080/v1/agents/bot%40prod/card");
    expect(upstreamUrl(base, ["v1", "sessions", "ses_1", "stream"], "after=4")).toBe("http://api:8080/v1/sessions/ses_1/stream?after=4");
  });

  it("refuses anything outside /v1 and traversal attempts", () => {
    expect(upstreamUrl(base, ["metrics"], "")).toBeNull();
    expect(upstreamUrl(base, ["v1"], "")).toBeNull();
    expect(upstreamUrl(base, ["v1", "..", "metrics"], "")).toBeNull();
    expect(upstreamUrl(base, ["v1", "a/b"], "")).toBeNull();
    expect(upstreamUrl(base, ["v2", "agents"], "")).toBeNull();
  });
});

describe("headers and origin checks", () => {
  it("picks only the listed headers", () => {
    const h = pickHeaders(new Headers({ "Content-Type": "application/json", Cookie: "secret", "Last-Event-ID": "4" }), ["content-type", "last-event-id"]);
    expect([...h.entries()]).toEqual([
      ["content-type", "application/json"],
      ["last-event-id", "4"],
    ]);
  });

  it("accepts same-origin and rejects cross-site requests", () => {
    expect(isSameOrigin(new Headers({ origin: "http://localhost:3000", host: "localhost:3000" }))).toBe(true);
    expect(isSameOrigin(new Headers({ origin: "https://dash.example.com", host: "internal:3000", "x-forwarded-host": "dash.example.com" }))).toBe(true);
    expect(isSameOrigin(new Headers({ origin: "https://evil.example", host: "localhost:3000" }))).toBe(false);
    expect(isSameOrigin(new Headers({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOrigin(new Headers({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOrigin(new Headers())).toBe(true);
  });

  it("parses the project cookie defensively", () => {
    expect(parseProjectCookie('{"id":"p","name":"Acme","role":"admin"}')).toEqual({ id: "p", name: "Acme", role: "admin" });
    expect(parseProjectCookie("garbage")).toBeNull();
    expect(parseProjectCookie(undefined)).toBeNull();
  });
});

describe("prependChunk", () => {
  it("emits the chunk first, then the body, and propagates cancel", async () => {
    const enc = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("id: 1\ndata: {}\n\n"));
        c.close();
      },
    });
    const text = await new Response(prependChunk(SSE_PREAMBLE, body)).text();
    expect(text).toBe(": connected\n\nid: 1\ndata: {}\n\n");

    const endless = new ReadableStream<Uint8Array>({ cancel: () => void (cancelled = true) });
    const reader = prependChunk(SSE_PREAMBLE, endless).getReader();
    expect((await reader.read()).value).toEqual(SSE_PREAMBLE);
    await reader.cancel();
    expect(cancelled).toBe(true);
  });
});
