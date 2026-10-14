import { describe, expect, it } from "vitest";
import { aliasesForVersion, canaryTarget, describeTarget, isValidAliasName, promoteTarget, validateTarget } from "./alias";
import { errorMessage, proxyUrl } from "./client";
import { compactNumber, formatBytes, formatDuration, shortId, timeAgo } from "./format";
import { fillDays, niceMax, totalsByDay } from "./usage";
import type { UsageRow } from "./api";

describe("alias targets", () => {
  it("promotes a single version", () => {
    expect(promoteTarget(3)).toEqual({ versions: [{ version: 3, weight: 100 }] });
    expect(() => promoteTarget(0)).toThrow();
  });

  it("builds canary splits and collapses the edges", () => {
    expect(canaryTarget(3, 4, 10)).toEqual({ versions: [{ version: 3, weight: 90 }, { version: 4, weight: 10 }] });
    expect(canaryTarget(3, 4, 12.6).versions[1]).toEqual({ version: 4, weight: 13 });
    expect(canaryTarget(3, 4, 0)).toEqual(promoteTarget(3));
    expect(canaryTarget(3, 4, 100)).toEqual(promoteTarget(4));
    expect(canaryTarget(3, 3, 50)).toEqual(promoteTarget(3));
    expect(() => canaryTarget(3, 4, 101)).toThrow();
    expect(() => canaryTarget(0, 4, 10)).toThrow();
  });

  it("validates and describes targets", () => {
    expect(validateTarget(canaryTarget(1, 2, 25))).toBeNull();
    expect(validateTarget({ versions: [{ version: 1, weight: 50 }] })).toMatch(/50/);
    expect(validateTarget({ versions: [{ version: 1, weight: 50 }, { version: 1, weight: 50 }] })).toMatch(/twice/);
    expect(validateTarget({ versions: [] })).toMatch(/at least one/);
    expect(validateTarget({ versions: [{ version: 2, weight: 100 }] })).toBeNull();
    expect(describeTarget([{ version: 2, weight: 100 }])).toBe("v2");
    expect(describeTarget([{ version: 2, weight: 90 }, { version: 3, weight: 10 }])).toBe("v2 90% · v3 10%");
    expect(describeTarget([])).toBe("(none)");
  });

  it("finds the aliases pointing at a version", () => {
    const aliases = [
      { alias: "prod", versions: [{ version: 1, weight: 90 }, { version: 2, weight: 10 }], updated_at: "" },
      { alias: "dev", versions: [{ version: 2, weight: 100 }], updated_at: "" },
    ];
    expect(aliasesForVersion(aliases, 2)).toEqual([
      { alias: "prod", weight: 10 },
      { alias: "dev", weight: 100 },
    ]);
    expect(aliasesForVersion(aliases, 9)).toEqual([]);
  });

  it("checks alias names", () => {
    expect(isValidAliasName("canary")).toBe(true);
    expect(isValidAliasName("prod-eu_2")).toBe(true);
    expect(isValidAliasName("a@b")).toBe(false);
    expect(isValidAliasName("")).toBe(false);
  });
});

describe("usage rollups", () => {
  const row = (day: string, model: string, input: number, output: number): UsageRow => ({
    day,
    model,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: 1,
    cache_write_tokens: 0,
    sandbox_seconds: 2,
    tool_calls: 1,
    runs: 1,
  });

  it("sums per day across models, oldest first", () => {
    const days = totalsByDay([row("2026-10-02T00:00:00Z", "b", 5, 5), row("2026-10-01T00:00:00Z", "a", 10, 2), row("2026-10-02T00:00:00+00:00", "a", 1, 1)]);
    expect(days.map((d) => [d.day, d.input_tokens, d.output_tokens, d.runs, d.models])).toEqual([
      ["2026-10-01", 10, 2, 1, ["a"]],
      ["2026-10-02", 6, 6, 2, ["b", "a"]],
    ]);
  });

  it("fills gaps with zero days", () => {
    const filled = fillDays(totalsByDay([row("2026-10-01T00:00:00Z", "a", 1, 1), row("2026-10-04T00:00:00Z", "a", 1, 1)]), "2026-09-30", "2026-10-04");
    expect(filled.map((d) => [d.day, d.input_tokens])).toEqual([
      ["2026-09-30", 0],
      ["2026-10-01", 1],
      ["2026-10-02", 0],
      ["2026-10-03", 0],
      ["2026-10-04", 1],
    ]);
  });

  it("picks nice axis maxima", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(1200)).toBe(2000);
    expect(niceMax(2100)).toBe(2500);
    expect(niceMax(40_000)).toBe(50_000);
  });
});

describe("client helpers", () => {
  it("builds proxy URLs and drops empty query values", () => {
    expect(proxyUrl("/v1/agents", { q: "bo t", tag: "", owner: undefined })).toBe("/api/proxy/v1/agents?q=bo+t");
    expect(proxyUrl("v1/usage")).toBe("/api/proxy/v1/usage");
  });

  it("extracts error messages from the server's error shapes", () => {
    expect(errorMessage(404, { error: "not_found", message: "no agent bot" })).toBe("no agent bot");
    expect(errorMessage(422, { error: "invalid_request", problems: ["body.versions: too short", "x: bad"] })).toBe("body.versions: too short; x: bad");
    expect(errorMessage(422, { error: "invalid_definition", message: null, problems: ["a", "b"] })).toBe("a; b");
    expect(errorMessage(409, { error: "conflict" })).toBe("conflict");
    expect(errorMessage(429, { error: "rate_limited", message: "", problems: [] })).toBe("rate limited");
    // Older servers: bare FastAPI errors.
    expect(errorMessage(403, { detail: "this needs the admin role" })).toBe("this needs the admin role");
    expect(errorMessage(422, { detail: [{ msg: "field required" }, { msg: "too big" }] })).toBe("field required; too big");
    expect(errorMessage(500, null)).toBe("request failed (500)");
  });
});

describe("format", () => {
  it("formats numbers, bytes, durations and ids", () => {
    expect(compactNumber(999)).toBe("999");
    expect(compactNumber(1234)).toBe("1.2k");
    expect(compactNumber(2_000_000)).toBe("2M");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(3500)).toBe("3.5s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(shortId("ses_0123456789abcdef")).toBe("ses_01234567…");
    expect(shortId("short")).toBe("short");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-01-10T12:00:00Z");
  it("buckets recent times", () => {
    expect(timeAgo("2026-01-10T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-01-10T11:55:00Z", now)).toBe("5m ago");
    expect(timeAgo("2026-01-10T09:00:00Z", now)).toBe("3h ago");
    expect(timeAgo("2026-01-08T12:00:00Z", now)).toBe("2d ago");
  });
  it("handles missing and invalid input", () => {
    expect(timeAgo(null, now)).toBe("–");
    expect(timeAgo("nope", now)).toBe("nope");
  });
});
