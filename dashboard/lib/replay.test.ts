import { describe, expect, it } from "vitest";
import type { ApiEvent } from "./api";
import { initialReplay, nextDelay, recordedOffsetMs, replayReducer, replaySessionReducer, startReplay, timelineAt, type ReplayState } from "./replay";
import { buildTimeline } from "./timeline";

const events: ApiEvent[] = [0, 100, 150, 5150, 5200].map((ms, i) => ({
  session_id: "s",
  seq: i + 1,
  type: i === 0 ? "message.user" : "message.agent.delta",
  ts: new Date(1_700_000_000_000 + ms).toISOString(),
  payload: { text: `t${i}` },
  run_id: "r",
}));

describe("replayReducer", () => {
  const total = events.length;
  const at = (cursor: number, playing = false): ReplayState => ({ cursor, playing, speed: 1 });

  it("starts at the beginning or the end", () => {
    expect(initialReplay(5)).toEqual(at(0));
    expect(initialReplay(5, { atEnd: true })).toEqual(at(5));
  });

  it("steps and seeks within bounds and stops playback when stepping", () => {
    expect(replayReducer(at(2, true), { type: "step", delta: 1 }, total)).toEqual(at(3));
    expect(replayReducer(at(0), { type: "step", delta: -1 }, total)).toEqual(at(0));
    expect(replayReducer(at(4), { type: "step", delta: 10 }, total)).toEqual(at(5));
    expect(replayReducer(at(1), { type: "seek", cursor: 3.6 }, total)).toEqual(at(4));
    expect(replayReducer(at(1), { type: "seek", cursor: 99 }, total)).toEqual(at(5));
    expect(replayReducer(at(3, true), { type: "start" }, total)).toEqual(at(0));
    expect(replayReducer(at(3, true), { type: "end" }, total)).toEqual(at(5));
  });

  it("plays, ticks to the end and stops; play at the end restarts", () => {
    let s = replayReducer(at(3), { type: "play" }, total);
    expect(s.playing).toBe(true);
    s = replayReducer(s, { type: "tick" }, total);
    expect(s).toEqual(at(4, true));
    s = replayReducer(s, { type: "tick" }, total);
    expect(s).toEqual(at(5, false));
    expect(replayReducer(s, { type: "tick" }, total)).toBe(s);
    expect(replayReducer(s, { type: "play" }, total)).toEqual(at(0, true));
    expect(replayReducer(at(0), { type: "play" }, 0).playing).toBe(false);
  });

  it("toggles and changes speed", () => {
    expect(replayReducer(at(1), { type: "toggle" }, total).playing).toBe(true);
    expect(replayReducer(at(1, true), { type: "toggle" }, total).playing).toBe(false);
    expect(replayReducer(at(1), { type: "speed", speed: 4 }, total).speed).toBe(4);
    expect(replayReducer(at(1), { type: "speed", speed: 0 }, total).speed).toBe(1);
  });
});

describe("nextDelay", () => {
  it("uses recorded gaps scaled by speed and clamped", () => {
    expect(nextDelay(events, 1, 1)).toBe(100);
    expect(nextDelay(events, 1, 2)).toBe(50);
    expect(nextDelay(events, 2, 1)).toBe(50);
    expect(nextDelay(events, 3, 1)).toBe(1500); // 5s idle gap compressed
    expect(nextDelay(events, 3, 1, { maxMs: 10_000 })).toBe(5000);
    expect(nextDelay(events, 4, 1, { minMs: 100 })).toBe(100);
    expect(nextDelay(events, 0, 1)).toBe(15);
  });

  it("copes with missing timestamps", () => {
    expect(nextDelay([{ ts: undefined }, { ts: "garbage" }], 1, 1)).toBe(15);
  });
});

describe("timelineAt", () => {
  it("advances incrementally and rebuilds when seeking backwards", () => {
    const a = timelineAt(null, events, 2);
    expect(a.timeline).toEqual(buildTimeline(events.slice(0, 2)));
    const b = timelineAt(a, events, 4);
    expect(b.timeline).toEqual(buildTimeline(events.slice(0, 4)));
    expect(a.timeline).toEqual(buildTimeline(events.slice(0, 2))); // untouched
    expect(timelineAt(b, events, 4)).toBe(b);
    const c = timelineAt(b, events, 1);
    expect(c.timeline).toEqual(buildTimeline(events.slice(0, 1)));
    expect(timelineAt(c, events, 99).cursor).toBe(5);
  });

  it("rebuilds when the event list changes", () => {
    const a = timelineAt(null, events, 3);
    const more = [...events];
    expect(timelineAt(a, more, 3)).not.toBe(a);
  });
});

describe("recordedOffsetMs", () => {
  it("measures from the first event", () => {
    expect(recordedOffsetMs(events, 0)).toBe(0);
    expect(recordedOffsetMs(events, 1)).toBe(0);
    expect(recordedOffsetMs(events, 4)).toBe(5150);
    expect(recordedOffsetMs(events, 50)).toBe(5200);
  });
});

describe("replaySessionReducer", () => {
  it("keeps the timeline in step with the cursor", () => {
    let s = startReplay(events);
    expect(s.replay.cursor).toBe(0);
    expect(s.cache.timeline.items).toEqual([]);
    s = replaySessionReducer(s, { type: "step", delta: 2 });
    expect(s.cache.timeline).toEqual(buildTimeline(events.slice(0, 2)));
    s = replaySessionReducer(s, { type: "end" });
    expect(s.cache.timeline).toEqual(buildTimeline(events));
    const same = replaySessionReducer(s, { type: "pause" });
    expect(same).toBe(s);
    s = replaySessionReducer(s, { type: "seek", cursor: 1 });
    expect(s.cache.timeline).toEqual(buildTimeline(events.slice(0, 1)));
    expect(startReplay(events, { atEnd: true }).cache.cursor).toBe(events.length);
  });
});
