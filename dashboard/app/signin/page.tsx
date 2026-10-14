import type { Metadata } from "next";
import { config } from "@/lib/server/auth";
import { SignInForm } from "./signin-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ expired?: string; next?: string }> }) {
  const { expired, next } = await searchParams;
  const cfg = config();
  // Only same-site relative paths are honoured after sign-in.
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/agents";
  return (
    <div className="signin">
      <div className="card">
        <h1>Managed Agents</h1>
        <p className="muted">Sign in with a project API key. The key is kept in an httpOnly cookie on this dashboard&apos;s server and is never exposed to the page.</p>
        {expired ? (
          <div className="banner warn" role="status">
            Your session ended or the key is no longer valid. Sign in again.
          </div>
        ) : null}
        <SignInForm defaultUrl={cfg.defaultUrl} allowed={cfg.allowed} next={safeNext} />
      </div>
    </div>
  );
}
