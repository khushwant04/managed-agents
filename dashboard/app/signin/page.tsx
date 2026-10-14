import type { Metadata } from "next"
import { config } from "@/lib/server/auth"
import { SignInForm } from "./signin-form"

export const metadata: Metadata = { title: "Sign in" }

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string; next?: string }>
}) {
  const { expired, next } = await searchParams
  const cfg = config()
  // Only same-site relative paths are honoured after sign-in.
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/"
  return <SignInForm defaultUrl={cfg.defaultUrl} allowed={cfg.allowed} next={safeNext} expired={!!expired} />
}
