/**
 * Replay of a recorded session: a cursor over the event list (how many events
 * are applied), play/pause, speed, and the delay before the next event derived
 * from the recorded timestamps.
 */
import type { ApiEvent } from "./api";
import { applyEvents, buildTimeline, type TimelineState } from "./timeline";

export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8, 16] as const;

export interface ReplayState {
  /** Number of events applied: 0 (nothing) … total (everything). */
  cursor: number;
  playing: boolean;
  speed: number;
}

export type ReplayAction =
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  | { type: "step"; delta: number }
  | { type: "seek"; cursor: number }
  | { type: "start" }
  | { type: "end" }
  | { type: "speed"; speed: number }
  | { type: "tick" };

export function initialReplay(total: number, opts: { atEnd?: boolean } = {}): ReplayState {
  return { cursor: opts.atEnd ? total : 0, playing: false, speed: 1 };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Pure replay reducer; `total` is the number of recorded events. */
export function replayReducer(state: ReplayState, action: ReplayAction, total: number): ReplayState {
  switch (action.type) {
    case "play":
      // Playing from the end restarts from the beginning.
      return { ...state, playing: total > 0, cursor: state.cursor >= total ? 0 : state.cursor };
    case "pause":
      return state.playing ? { ...state, playing: false } : state;
    case "toggle":
      return replayReducer(state, { type: state.playing ? "pause" : "play" }, total);
    case "step":
      return { ...state, playing: false, cursor: clamp(state.cursor + Math.trunc(action.delta), 0, total) };
    case "seek":
      return { ...state, cursor: clamp(Math.round(action.cursor), 0, total) };
    case "start":
      return { ...state, playing: false, cursor: 0 };
    case "end":
      return { ...state, playing: false, cursor: total };
    case "speed":
      return action.speed > 0 ? { ...state, speed: action.speed } : state;
    case "tick": {
      if (!state.playing) return state;
      const cursor = clamp(state.cursor + 1, 0, total);
      return { ...state, cursor, playing: cursor < total };
    }
    default:
      return state;
  }
}

export interface DelayOptions {
  /** Shortest gap between events, ms (before speed scaling). */
  minMs?: number;
  /** Longest gap between events, ms (idle gaps are compressed to this). */
  maxMs?: number;
}

/**
 * Milliseconds to wait before applying event `cursor` (0-based index of the
 * next event), from the gap between its timestamp and the previous one,
 * clamped to [minMs, maxMs] and divided by speed.
 */
export function nextDelay(events: readonly Pick<ApiEvent, "ts">[], cursor: number, speed: number, opts: DelayOptions = {}): number {
  const minMs = opts.minMs ?? 15;
  const maxMs = opts.maxMs ?? 1500;
  if (cursor <= 0 || cursor >= events.length) return minMs / speed;
  const prev = Date.parse(events[cursor - 1]?.ts ?? "");
  const next = Date.parse(events[cursor]?.ts ?? "");
  const gap = Number.isFinite(prev) && Number.isFinite(next) ? next - prev : minMs;
  return clamp(gap, minMs, maxMs) / Math.max(speed, 0.01);
}

/** Cache of the timeline at some cursor, so stepping forward is incremental. */
export interface ReplayCache {
  events: readonly ApiEvent[];
  cursor: number;
  timeline: TimelineState;
}

/**
 * Timeline for `events[0:cursor]`. Moving forward over the same event list
 * applies only the new events; moving backward (or a different list) rebuilds.
 */
export function timelineAt(cache: ReplayCache | null, events: readonly ApiEvent[], cursor: number): ReplayCache {
  const target = clamp(cursor, 0, events.length);
  if (cache && cache.events === events && cache.cursor === target) return cache;
  if (cache && cache.events === events && cache.cursor < target) {
    return { events, cursor: target, timeline: applyEvents(cache.timeline, events.slice(cache.cursor, target)) };
  }
  return { events, cursor: target, timeline: buildTimeline(events.slice(0, target)) };
}

/** Recorded time elapsed between the first event and the one at the cursor, in ms. */
export function recordedOffsetMs(events: readonly Pick<ApiEvent, "ts">[], cursor: number): number {
  if (events.length === 0 || cursor <= 0) return 0;
  const first = Date.parse(events[0]?.ts ?? "");
  const at = Date.parse(events[Math.min(cursor, events.length) - 1]?.ts ?? "");
  return Number.isFinite(first) && Number.isFinite(at) ? Math.max(0, at - first) : 0;
}

/** Replay controls plus the timeline they produce, for a fixed snapshot of events. */
export interface ReplaySession {
  replay: ReplayState;
  cache: ReplayCache;
}

export function startReplay(events: readonly ApiEvent[], opts: { atEnd?: boolean } = {}): ReplaySession {
  const replay = initialReplay(events.length, opts);
  return { replay, cache: timelineAt(null, events, replay.cursor) };
}

/** Reducer for a replay session: moves the cursor and keeps the timeline in step. */
export function replaySessionReducer(state: ReplaySession, action: ReplayAction): ReplaySession {
  const events = state.cache.events;
  const replay = replayReducer(state.replay, action, events.length);
  if (replay === state.replay) return state;
  return { replay, cache: timelineAt(state.cache, events, replay.cursor) };
}
