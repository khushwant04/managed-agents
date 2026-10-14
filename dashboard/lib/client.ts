import { isErrorBody } from "./api";

/**
 * Browser-side API access. Everything goes through the dashboard's own
 * `/api/proxy/...` route, which adds the API key server-side.
 */

export const PROXY_PREFIX = "/api/proxy";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    // `body` is the parsed response; an `ErrorBody` when the API produced the error.
    super(message);
    this.name = "ApiError";
  }
}

/** URL of an API path through the proxy, e.g. proxyUrl("/v1/agents", { q: "bot" }). */
export function proxyUrl(path: string, query?: Record<string, string | number | boolean | null | undefined>): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== null && v !== undefined && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return `${PROXY_PREFIX}${clean}${s ? `?${s}` : ""}`;
}

/** Path segment encoder for names and ids inside API paths. */
export const seg = (s: string | number) => encodeURIComponent(String(s));

/**
 * Human-readable message from an error response: the API's `ErrorBody`
 * (`message`, then `problems`, then the `error` code), falling back to a bare
 * FastAPI `detail` from older servers.
 */
export function errorMessage(status: number, body: unknown): string {
  if (isErrorBody(body)) {
    if (body.message) return body.message;
    if (body.problems?.length) return body.problems.join("; ");
    return body.error.replace(/_/g, " ");
  }
  if (body && typeof body === "object") {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail.map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : JSON.stringify(d))).join("; ");
    }
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  return `request failed (${status})`;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  json?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
}

/** Call the API through the proxy and parse JSON. Throws ApiError on non-2xx. */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(proxyUrl(path, opts.query), {
    method: opts.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body,
    signal: opts.signal,
    credentials: "same-origin",
    cache: "no-store",
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") onUnauthenticated();
    throw new ApiError(res.status, errorMessage(res.status, parsed), parsed);
  }
  return parsed as T;
}

let redirecting = false;

/** The session cookie is gone or the key was revoked: go back to sign-in. */
export function onUnauthenticated(): void {
  if (redirecting || typeof window === "undefined") return;
  redirecting = true;
  const next = window.location.pathname + window.location.search;
  // A full navigation on purpose: drop all client state once the session is gone.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/signin?expired=1&next=${encodeURIComponent(next)}`);
}
