import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import type { ReactNode } from "react"
import { AppShell } from "@/components/shell/app-shell"
import { config, currentProject } from "@/lib/server/auth"
import { COOKIE_BASE, resolveUpstream } from "@/lib/proxy"

/** Signed-in console: redirects to sign-in when there is no session cookie. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const project = await currentProject()
  if (!project) redirect("/signin")
  const jar = await cookies()
  const cfg = config()
  const server = resolveUpstream(cfg, jar.get(COOKIE_BASE)?.value) ?? cfg.defaultUrl
  const defaultOpen = jar.get("sidebar_state")?.value !== "false"
  return (
    <AppShell project={{ ...project, server }} defaultOpen={defaultOpen}>
      {children}
    </AppShell>
  )
}
