/** Display formatting helpers (pure, locale-stable where it matters for tests). */

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return n.toLocaleString("en-US");
}

/** 1234 → "1.2k", 2_500_000 → "2.5M". */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `${trim(n / 1e3)}k`;
  return String(Math.round(n));
}

function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${trim(v)} ${units[i]}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** 65_000 → "1m 05s"; 3_500 → "3.5s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${trim(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.floor(s % 60);
  if (m < 60) return `${m}m ${String(rest).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function shortId(id: string | null | undefined, keep = 8): string {
  if (!id) return "–";
  const underscore = id.indexOf("_");
  const prefix = underscore > 0 ? id.slice(0, underscore + 1) : "";
  const rest = id.slice(prefix.length);
  return rest.length > keep ? `${prefix}${rest.slice(0, keep)}…` : id;
}

/** Pretty JSON for display; strings are shown as-is. */
export function toDisplay(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
