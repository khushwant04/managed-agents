import { NextResponse, type NextRequest } from "next/server";
import type { ErrorBody } from "@/lib/api";
import { FORWARD_REQUEST_HEADERS, FORWARD_RESPONSE_HEADERS, SSE_PREAMBLE, isSameOrigin, pickHeaders, prependChunk, upstreamUrl } from "@/lib/proxy";
import { credentialsFrom } from "@/lib/server/auth";

/**
 * Same-origin proxy to the Runhive API. The browser never sees the API
 * key: it is read from the httpOnly cookie and added here. Response bodies are
 * streamed through untouched, so `/v1/sessions/{id}/stream` (SSE) and artifact
 * downloads are not buffered.
 */
type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const creds = credentialsFrom(req);
  if (!creds) return NextResponse.json<ErrorBody>({ error: "unauthenticated", message: "Sign in again." }, { status: 401 });
  if (req.method !== "GET" && req.method !== "HEAD" && !isSameOrigin(req.headers)) {
    return NextResponse.json<ErrorBody>({ error: "forbidden", message: "cross-origin request refused" }, { status: 403 });
  }
  const { path } = await ctx.params;
  const target = upstreamUrl(creds.base, path, req.nextUrl.search);
  if (!target) return NextResponse.json<ErrorBody>({ error: "not_found", message: "only /v1 API paths are proxied" }, { status: 404 });

  const headers = pickHeaders(req.headers, FORWARD_REQUEST_HEADERS);
  headers.set("Authorization", `Bearer ${creds.key}`);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      cache: "no-store",
      redirect: "manual",
      // Abort the upstream request (and an SSE subscription) when the browser goes away.
      signal: req.signal,
    });
  } catch (err) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return NextResponse.json<ErrorBody>({ error: "bad_gateway", message: `could not reach the API server: ${(err as Error).message}` }, { status: 502 });
  }

  const out = pickHeaders(upstream.headers, FORWARD_RESPONSE_HEADERS);
  const isStream = (upstream.headers.get("content-type") ?? "").startsWith("text/event-stream");
  if (isStream) {
    // no-transform keeps the server's compression from buffering the stream.
    out.set("Cache-Control", "no-cache, no-transform");
    out.set("X-Accel-Buffering", "no");
  } else if (!out.has("cache-control")) {
    out.set("Cache-Control", "no-store");
  }
  let body: ReadableStream<Uint8Array> | null = upstream.status === 204 || upstream.status === 304 ? null : upstream.body;
  // Flush headers now; otherwise they wait for the first event or keepalive (up to 15s).
  if (isStream && body && upstream.ok) body = prependChunk(SSE_PREAMBLE, body);
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
