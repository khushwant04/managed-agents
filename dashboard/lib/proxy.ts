/**
 * Pure helpers for the API proxy and sign-in: which upstream URLs are allowed,
 * how a proxied path maps to an upstream URL, and which headers pass through.
 * Kept free of Next.js imports so they can be unit tested.
 */

export const COOKIE_KEY = "ma_key";
export const COOKIE_BASE = "ma_base";
export const COOKIE_PROJECT = "ma_project";
export const SESSION_MAX_AGE_S = 12 * 60 * 60;

/** Normalise a base URL: http(s) only, no credentials/query/fragment, no trailing slash. */
export function normalizeBaseUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

export interface UpstreamConfig {
  /** Default upstream (RUNHIVE_API_URL). */
  defaultUrl: string;
  /** Every upstream the sign-in form may choose (always includes the default). */
  allowed: string[];
}

/**
 * Reads RUNHIVE_API_URL (default http://localhost:8080) and the optional
 * comma-separated RUNHIVE_API_URL_ALLOWLIST of extra servers users may pick at
 * sign-in. Anything else is refused so the dashboard can't be used to reach
 * arbitrary hosts.
 */
export function upstreamConfig(env: Record<string, string | undefined>): UpstreamConfig {
  const defaultUrl = normalizeBaseUrl(env.RUNHIVE_API_URL || "http://localhost:8080") ?? "http://localhost:8080";
  const extra = (env.RUNHIVE_API_URL_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeBaseUrl)
    .filter((s): s is string => s !== null);
  return { defaultUrl, allowed: [...new Set([defaultUrl, ...extra])] };
}

/** The upstream to use for a requested override: the override if allowed, the default if empty, else null. */
export function resolveUpstream(cfg: UpstreamConfig, requested: string | null | undefined): string | null {
  if (!requested || !requested.trim()) return cfg.defaultUrl;
  const norm = normalizeBaseUrl(requested);
  return norm && cfg.allowed.includes(norm) ? norm : null;
}

/**
 * Upstream URL for a proxied request, or null if the path is not an API path.
 * Only `/v1/...` is reachable, and dot segments are rejected.
 */
export function upstreamUrl(base: string, segments: readonly string[], search: string): string | null {
  if (segments.length < 2 || segments[0] !== "v1") return null;
  for (const s of segments) {
    if (s === "" || s === "." || s === ".." || s.includes("/") || s.includes("\\")) return null;
  }
  const path = segments.map((s) => encodeURIComponent(s)).join("/");
  const qs = search && search !== "?" ? (search.startsWith("?") ? search : `?${search}`) : "";
  return `${base}/${path}${qs}`;
}

/** Request headers forwarded upstream (besides Authorization, which the proxy sets). */
export const FORWARD_REQUEST_HEADERS = ["accept", "content-type", "last-event-id", "if-none-match"] as const;

/** Response headers passed back to the browser. */
export const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "cache-control",
  "etag",
  "last-modified",
  "retry-after",
] as const;

export function pickHeaders(source: Headers, names: readonly string[]): Headers {
  const out = new Headers();
  for (const n of names) {
    const v = source.get(n);
    if (v !== null) out.set(n, v);
  }
  return out;
}

/**
 * Same-origin check for state-changing requests (defence in depth on top of
 * SameSite=Strict cookies). The Origin's host must match the Host the request
 * was sent to (X-Forwarded-Host first, for reverse proxies). Requests without an
 * Origin header fall back to Sec-Fetch-Site when present (non-browser clients
 * send neither and carry no ambient cookie risk).
 */
export function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (origin) {
    const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0]!.trim();
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  return true;
}

export interface ProjectCookie {
  id: string;
  name: string;
  role: string;
}

export function parseProjectCookie(value: string | undefined): ProjectCookie | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as Partial<ProjectCookie>;
    if (typeof v.name === "string" && typeof v.role === "string") return { id: String(v.id ?? ""), name: v.name, role: v.role };
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Prefix a body stream with a chunk. The proxy uses it to send an SSE comment
 * straight away: Next.js only flushes response headers with the first body
 * chunk, and a quiet session stream may not send one for a while.
 * Cancelling the result cancels the source (and so the upstream request).
 */
export function prependChunk(chunk: Uint8Array, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export const SSE_PREAMBLE = new TextEncoder().encode(": connected\n\n");
