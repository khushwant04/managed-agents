import { NextResponse, type NextRequest } from "next/server";
import type { ErrorBody, Project } from "@/lib/api";
import { COOKIE_BASE, COOKIE_KEY, COOKIE_PROJECT, SESSION_MAX_AGE_S, isSameOrigin, resolveUpstream } from "@/lib/proxy";
import { config, secureCookies } from "@/lib/server/auth";

/**
 * Sign in with an API key: validate it against `GET /v1/project` on the chosen
 * upstream, then keep it in an httpOnly cookie. The key never reaches page JS.
 */
function fail(status: number, error: string, message: string) {
  return NextResponse.json<ErrorBody>({ error, message }, { status });
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req.headers)) {
    return fail(403, "forbidden", "cross-origin request refused");
  }
  let body: { apiKey?: unknown; serverUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, "bad_request", "expected a JSON body");
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) return fail(400, "bad_request", "enter an API key");
  const cfg = config();
  const base = resolveUpstream(cfg, typeof body.serverUrl === "string" ? body.serverUrl : null);
  if (!base) {
    return fail(400, "bad_request", "that server is not on this dashboard's allowlist (AGENTS_API_URL_ALLOWLIST)");
  }

  let res: Response;
  try {
    res = await fetch(`${base}/v1/project`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return fail(502, "bad_gateway", `could not reach ${base}`);
  }
  if (res.status === 401 || res.status === 403) {
    return fail(401, "unauthenticated", "that API key was not accepted");
  }
  if (!res.ok) {
    return fail(502, "bad_gateway", `the server answered ${res.status}`);
  }
  const project = (await res.json()) as Project;

  const out = NextResponse.json({ project: { id: project.id, name: project.name, role: project.role } });
  const opts = { httpOnly: true, sameSite: "strict" as const, secure: secureCookies(req), path: "/", maxAge: SESSION_MAX_AGE_S };
  out.cookies.set(COOKIE_KEY, apiKey, opts);
  out.cookies.set(COOKIE_PROJECT, JSON.stringify({ id: project.id, name: project.name, role: project.role }), opts);
  if (base !== cfg.defaultUrl) out.cookies.set(COOKIE_BASE, base, opts);
  else out.cookies.delete(COOKIE_BASE);
  out.headers.set("Cache-Control", "no-store");
  return out;
}
