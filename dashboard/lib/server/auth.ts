import "server-only";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { COOKIE_BASE, COOKIE_KEY, COOKIE_PROJECT, parseProjectCookie, resolveUpstream, upstreamConfig, type ProjectCookie } from "../proxy";

export function config() {
  return upstreamConfig(process.env);
}

export interface Credentials {
  key: string;
  base: string;
}

/** API key and upstream for a request, or null when not signed in (or the stored upstream is no longer allowed). */
export function credentialsFrom(req: NextRequest): Credentials | null {
  const key = req.cookies.get(COOKIE_KEY)?.value;
  if (!key) return null;
  const base = resolveUpstream(config(), req.cookies.get(COOKIE_BASE)?.value);
  return base ? { key, base } : null;
}

/** For server components: who is signed in (no network call). */
export async function currentProject(): Promise<ProjectCookie | null> {
  const jar = await cookies();
  if (!jar.get(COOKIE_KEY)?.value) return null;
  return parseProjectCookie(jar.get(COOKIE_PROJECT)?.value) ?? { id: "", name: "project", role: "viewer" };
}

/** Whether cookies should carry the Secure flag for this request. */
export function secureCookies(req: NextRequest): boolean {
  if (process.env.DASHBOARD_INSECURE_COOKIES === "1") return false;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? req.nextUrl.protocol.replace(":", "");
  return proto === "https";
}
