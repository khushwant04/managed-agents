import { describe, expect, it } from "vitest";
import { cronError, describeCron } from "./cron";
import { draftError, draftToTrigger, describeTrigger, newDraft, parseTrigger, webhookEndpoints } from "./triggers";
import { bundleKind, gunzip, prepareSkillBundle, readZip, stripWrapper, tar } from "./skill-bundle";
import type { Deployment } from "./api";

describe("cron", () => {
  it("validates", () => {
    expect(cronError("*/30 * * * *")).toBeNull();
    expect(cronError("0 9 * * mon-fri")).toBeNull();
    expect(cronError("@daily")).toBeNull();
    expect(cronError("* * * *")).toMatch(/5 fields/);
    expect(cronError("61 * * * *")).toMatch(/minute/);
    expect(cronError("*/0 * * * *")).toMatch(/step/);
    expect(cronError("")).toBe("enter a schedule");
  });
  it("describes common schedules", () => {
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("*/30 * * * *")).toBe("Every 30 minutes");
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("15 * * * *")).toBe("Every hour at :15");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours");
    expect(describeCron("0 9 * * *")).toBe("Every day at 09:00");
    expect(describeCron("0 9 * * 1-5")).toBe("At 09:00 on weekdays");
    expect(describeCron("30 8 * * 1")).toBe("At 08:30 on Monday");
    expect(describeCron("0 0 1 * *")).toBe("At 00:00 on the 1st");
    expect(describeCron("0 0 1 1 *")).toBe("At 00:00 on the 1st in January");
    expect(describeCron("0 9,17 * * *")).toBe("Every day at 09:00, 17:00");
    expect(describeCron("nope")).toBeNull();
  });
});

describe("triggers", () => {
  it("parses and describes", () => {
    expect(describeTrigger(parseTrigger({ type: "webhook", provider: "slack" }))).toBe("Webhook · Slack");
    expect(describeTrigger(parseTrigger({ type: "cron", schedule: "0 * * * *", input: "x" }))).toBe("Cron 0 * * * *");
    expect(describeTrigger(parseTrigger({ type: "queue", name: "tickets" }))).toBe("Queue tickets");
    expect(parseTrigger({ type: "webhook", provider: "weird" })).toEqual({ type: "webhook", provider: "generic", input: undefined });
  });
  it("turns drafts into payloads", () => {
    expect(draftToTrigger(newDraft("http"))).toEqual({ type: "http" });
    expect(draftToTrigger(newDraft("webhook", { provider: "stripe" }))).toEqual({ type: "webhook", provider: "stripe" });
    expect(draftToTrigger(newDraft("cron", { schedule: " 0  9 * * * ", input: "go", timezone: "Europe/Berlin" }))).toEqual({
      type: "cron",
      schedule: "0 9 * * *",
      input: "go",
      timezone: "Europe/Berlin",
    });
    expect(draftError(newDraft("cron", { input: "" }))).toMatch(/input/);
    expect(draftError(newDraft("queue", { queue: "" }))).toMatch(/name/);
    expect(draftError(newDraft("queue", { queue: "alerts" }))).toBeNull();
  });
  it("lists webhook endpoints", () => {
    const d = { id: "dep_1", triggers: [{ type: "http" }, { type: "webhook", provider: "github" }] } as unknown as Deployment;
    const eps = webhookEndpoints([d], "http://api/");
    expect(eps).toHaveLength(1);
    expect(eps[0]!.url).toBe("http://api/v1/hooks/dep_1");
    expect(eps[0]!.provider).toBe("github");
  });
});

// A minimal zip writer for the tests (stored + deflated entries).
async function makeZip(entries: { path: string; text: string; deflate?: boolean }[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const raw = enc.encode(e.text);
    const data = e.deflate
      ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer())
      : raw;
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, e.deflate ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, e.deflate ? 8 : 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    locals.push(lh, data);
    centrals.push(ch);
    offset += lh.length + data.length;
  }
  const cdSize = centrals.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function readTar(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const dec = new TextDecoder();
  let p = 0;
  while (p + 512 <= bytes.length && bytes[p] !== 0) {
    const field = (o: number, l: number) => dec.decode(bytes.subarray(p + o, p + o + l)).replace(/\0.*$/s, "");
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12), 8);
    out[prefix ? `${prefix}/${name}` : name] = dec.decode(bytes.subarray(p + 512, p + 512 + size));
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe("skill bundles", () => {
  it("detects kinds", () => {
    expect(bundleKind(new Uint8Array([0x1f, 0x8b, 0]))).toBe("gzip");
    expect(bundleKind(new Uint8Array([1, 2, 3]))).toBe("unknown");
  });
  it("reads stored and deflated zip entries", async () => {
    const zip = await makeZip([
      { path: "skill/", text: "" },
      { path: "skill/SKILL.md", text: "---\nname: demo\n---\nHello" },
      { path: "skill/scripts/run.py", text: "print('hi')\n".repeat(50), deflate: true },
      { path: "__MACOSX/skill/._SKILL.md", text: "junk" },
    ]);
    expect(bundleKind(zip)).toBe("zip");
    const files = await readZip(zip);
    expect(files.map((f) => f.path)).toEqual(["skill/SKILL.md", "skill/scripts/run.py"]);
    expect(stripWrapper(files).map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.py"]);
  });
  it("repacks a zip as a tar.gz with SKILL.md at the root", async () => {
    const zip = await makeZip([
      { path: "demo/SKILL.md", text: "---\nname: demo\n---\n", deflate: true },
      { path: "demo/a/b.txt", text: "b" },
    ]);
    const prepared = await prepareSkillBundle(zip);
    expect(prepared.converted).toBe(true);
    expect(bundleKind(prepared.body)).toBe("gzip");
    const entries = readTar(await gunzip(prepared.body));
    expect(entries).toEqual({ "SKILL.md": "---\nname: demo\n---\n", "a/b.txt": "b" });
  });
  it("passes tar.gz through and rejects bundles without SKILL.md", async () => {
    const gz = new Uint8Array([0x1f, 0x8b, 8, 0]);
    expect((await prepareSkillBundle(gz)).body).toBe(gz);
    await expect(prepareSkillBundle(await makeZip([{ path: "README.md", text: "x" }]))).rejects.toThrow(/SKILL\.md/);
    await expect(prepareSkillBundle(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/\.zip or \.tar\.gz/);
  });
  it("splits long paths into the ustar prefix", () => {
    const long = `${"d".repeat(80)}/${"e".repeat(60)}/file.txt`;
    expect(readTar(tar([{ path: long, data: new TextEncoder().encode("x") }], 0))).toEqual({ [long]: "x" });
  });
});
