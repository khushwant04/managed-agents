"use client";

import { useEffect, useState } from "react";
import type { ApiEvent, EventList } from "@/lib/api";
import { api, onUnauthenticated, proxyUrl, seg } from "@/lib/client";
import { eventFromMessage, SSEParser } from "@/lib/sse";
import { applyEvents, emptyTimeline, mergeEvents, type TimelineState } from "@/lib/timeline";

export type Connection = "loading" | "connecting" | "live" | "reconnecting" | "error";

const PAGE = 5000;
const FLUSH_MS = 50;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Load a session's history from `/events`, then follow `/stream?after=<last seq>`
 * through the proxy, reconnecting with backoff from the last seq seen. Events
 * are batched (every ~50ms) into both the raw list (for replay) and the
 * timeline view model.
 */
export function useSessionEvents(sessionId: string) {
  const [data, setData] = useState<{ events: ApiEvent[]; timeline: TimelineState }>(() => ({ events: [], timeline: emptyTimeline() }));
  const [connection, setConnection] = useState<Connection>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const { signal } = ctrl;
    let lastSeq = 0;
    let pending: ApiEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      const batch = pending;
      pending = [];
      if (batch.length === 0 || signal.aborted) return;
      setData((s) => ({ events: mergeEvents(s.events, batch), timeline: applyEvents(s.timeline, batch) }));
    };
    const push = (evs: ApiEvent[]) => {
      for (const e of evs) lastSeq = Math.max(lastSeq, e.seq ?? 0);
      pending.push(...evs);
      timer ??= setTimeout(flush, FLUSH_MS);
    };

    (async () => {
      try {
        for (;;) {
          const page = await api<EventList>(`/v1/sessions/${seg(sessionId)}/events`, { query: { after: lastSeq, limit: PAGE }, signal });
          push(page.events);
          if (page.events.length < PAGE) break;
        }
        flush();
      } catch (e) {
        if (signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setConnection("error");
        return;
      }

      let attempt = 0;
      while (!signal.aborted) {
        setConnection(attempt === 0 ? "connecting" : "reconnecting");
        try {
          const res = await fetch(proxyUrl(`/v1/sessions/${seg(sessionId)}/stream`, { after: lastSeq }), {
            headers: { Accept: "text/event-stream" },
            cache: "no-store",
            signal,
          });
          if (res.status === 401) {
            onUnauthenticated();
            return;
          }
          if (res.status === 404 || res.status === 403) {
            setError(`live updates unavailable (${res.status})`);
            setConnection("error");
            return;
          }
          if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`);
          setConnection("live");
          setError(null);
          attempt = 0;
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          const parser = new SSEParser();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const evs = parser.feed(value).map(eventFromMessage).filter((e): e is ApiEvent => e !== null);
            if (evs.length) push(evs);
          }
        } catch {
          if (signal.aborted) return;
        }
        attempt += 1;
        setConnection("reconnecting");
        await sleep(Math.min(500 * 2 ** attempt, 15_000), signal);
      }
    })();

    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  return { events: data.events, timeline: data.timeline, connection, error };
}
