import { describe, expect, it } from "vitest";
import type { AuditEntry, UsageRow } from "./api";
import { actorKeyId, deriveKeys } from "./keys";
import { checkPolicy, withPolicyKey } from "./policy";
import { byModel, rangeStart, sumUsage, usageCsv } from "./usage-report";

const row = (day: string, model: string | null, input: number, output: number, extra: Partial<UsageRow> = {}): UsageRow => ({
  day: `${day}T00:00:00Z`,
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  sandbox_seconds: 0,
  tool_calls: 0,
  runs: 1,
  ...extra,
});

describe("usage report", () => {
  it("sums totals and the cache hit rate", () => {
    const t = sumUsage([row("2026-01-01", "a", 30, 10, { cache_read_tokens: 10 }), row("2026-01-02", "b", 30, 10, { cache_read_tokens: 30 })]);
    expect(t.tokens).toBe(80);
    expect(t.cacheRead).toBe(40);
    expect(t.cacheHitRate).toBeCloseTo(0.4);
    expect(sumUsage([]).cacheHitRate).toBe(0);
  });

  it("breaks usage down by model, largest first", () => {
    const m = byModel([row("2026-01-01", "small", 10, 0), row("2026-01-01", "big", 60, 0), row("2026-01-02", "big", 20, 10), row("2026-01-02", null, 0, 0)]);
    expect(m.map((x) => x.model)).toEqual(["big", "small", "unknown"]);
    expect(m[0]!.share).toBeCloseTo(0.9);
    expect(m[0]!.runs).toBe(2);
  });

  it("computes the first day of a range", () => {
    expect(rangeStart("2026-03-02", 7)).toBe("2026-02-24");
    expect(rangeStart("2026-03-02", 1)).toBe("2026-03-02");
  });

  it("exports CSV newest first and quotes cells", () => {
    const csv = usageCsv([row("2026-01-01", "a", 1, 2), row("2026-01-02", 'we,"ird', 3, 4, { sandbox_seconds: 1.23456 })]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("day,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,runs,tool_calls,sandbox_seconds");
    expect(lines[1]).toBe('2026-01-02,"we,""ird",3,4,0,0,1,0,1.235');
    expect(lines[2]).toBe("2026-01-01,a,1,2,0,0,1,0,0");
  });
});

describe("keys from the audit log", () => {
  const e = (action: string, target: string, at: string, actor = "key:key_root", details: Record<string, unknown> = {}): AuditEntry => ({ actor, action, target, details, at });

  it("parses key actors", () => {
    expect(actorKeyId("key:key_abc")).toBe("key_abc");
    expect(actorKeyId("webhook:github")).toBeNull();
  });

  it("derives created, revoked and actor-only keys", () => {
    const keys = deriveKeys([
      e("key.revoke", "key_b", "2026-01-03T00:00:00Z"),
      e("key.create", "key_b", "2026-01-02T00:00:00Z", "key:key_root", { role: "viewer" }),
      e("key.create", "key_a", "2026-01-01T00:00:00Z", "key:key_root", { role: "developer" }),
      e("agent.register", "bot", "2026-01-04T00:00:00Z", "key:key_a"),
    ]);
    expect(keys.map((k) => k.id)).toEqual(["key_b", "key_a", "key_root"]);
    expect(keys[0]).toMatchObject({ role: "viewer", revokedAt: "2026-01-03T00:00:00Z", origin: "audit" });
    expect(keys[1]).toMatchObject({ role: "developer", revokedAt: null, lastSeenAt: "2026-01-04T00:00:00Z" });
    expect(keys[2]).toMatchObject({ origin: "actor", role: null, createdAt: null });
  });
});

describe("policy editor", () => {
  it("rejects invalid JSON and non-objects", () => {
    expect(checkPolicy("{").error).toBeTruthy();
    expect(checkPolicy("[1]").error).toMatch(/object/);
    expect(checkPolicy("").policy).toEqual({});
  });

  it("warns about unknown keys and wrong shapes", () => {
    const r = checkPolicy(JSON.stringify({ allowed_models: "x", budget: { max_tokens: "lots" }, agent_calls: { a: ["b"] }, nope: 1 }));
    expect(r.error).toBeNull();
    expect(r.warnings).toHaveLength(3);
  });

  it("inserts example values for missing keys", () => {
    const text = withPolicyKey('{"allowed_tools": ["shell"]}', "budget");
    expect(JSON.parse(text!)).toEqual({ allowed_tools: ["shell"], budget: { max_tokens: 5_000_000, window: "30 days" } });
    expect(withPolicyKey("nope", "budget")).toBeNull();
  });
});
