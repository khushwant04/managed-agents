import { NextResponse, type NextRequest } from "next/server";
import type { ErrorBody } from "@/lib/api";
import { COOKIE_BASE, COOKIE_KEY, COOKIE_PROJECT, isSameOrigin } from "@/lib/proxy";

/** Clear the session cookies. Accepts a form POST (redirects) or fetch (JSON). */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req.headers)) {
    return NextResponse.json<ErrorBody>({ error: "forbidden", message: "cross-origin request refused" }, { status: 403 });
  }
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
  // A relative Location keeps the browser on its own origin (req.url may carry an internal host behind a proxy).
  const out = wantsJson ? NextResponse.json({ ok: true }) : new NextResponse(null, { status: 303, headers: { Location: "/signin" } });
  for (const name of [COOKIE_KEY, COOKIE_PROJECT, COOKIE_BASE]) out.cookies.delete(name);
  return out;
}
