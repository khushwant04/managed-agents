"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { DoorOpenIcon, LogOutIcon, type LucideIcon, PaletteIcon, ScaleIcon, SlidersHorizontalIcon, SparklesIcon, UserRoundIcon } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Page, PageHeader } from "@/components/page"
import { EASE_OUT } from "@/components/motion"
import { CodeBlock } from "@/components/code-block"
import { CopyButton } from "@/components/copy-button"
import { ErrorState } from "@/components/states"
import { signOut, useCan, useProject } from "@/components/shell/project-context"
import { PolicyEditor } from "@/components/settings/policy-editor"
import { roleMeta } from "@/components/settings/roles"
import { ThemePreviewCards } from "@/components/settings/theme-preview"
import { useApi } from "@/hooks/use-api"
import type { Project } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

export type SettingsTab = "general" | "appearance" | "policy" | "session"

const TABS: { value: SettingsTab; label: string; icon: LucideIcon }[] = [
  { value: "general", label: "General", icon: SlidersHorizontalIcon },
  { value: "appearance", label: "Appearance", icon: PaletteIcon },
  { value: "policy", label: "Policy", icon: ScaleIcon },
  { value: "session", label: "Session", icon: UserRoundIcon },
]

export function SettingsView({ initialTab }: { initialTab: SettingsTab }) {
  const [tab, setTab] = React.useState<SettingsTab>(initialTab)
  const project = useApi<Project>("/v1/project")

  const select = (t: SettingsTab) => {
    setTab(t)
    const url = new URL(window.location.href)
    if (t === "general") url.searchParams.delete("tab")
    else url.searchParams.set("tab", t)
    window.history.replaceState(window.history.state, "", url)
  }

  return (
    <Page>
      <PageHeader title="Settings" description="Your project, how the console looks to you, and the rules every agent runs under." />

      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <nav aria-label="Settings sections" className="-mx-4 shrink-0 overflow-x-auto px-4 md:mx-0 md:w-48 md:overflow-visible md:px-0">
          <ul className="flex gap-1 md:sticky md:top-20 md:flex-col">
            {TABS.map((t) => {
              const active = tab === t.value
              return (
                <li key={t.value}>
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => select(t.value)}
                    className={cn(
                      "relative flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-sm whitespace-nowrap text-muted-foreground transition-colors duration-200 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                      active && "font-medium text-foreground"
                    )}
                  >
                    {active ? (
                      <motion.span
                        layoutId="settings-nav"
                        className="absolute inset-0 rounded-lg bg-muted"
                        transition={{ type: "spring", bounce: 0.15, duration: 0.4 }}
                      />
                    ) : null}
                    <t.icon className="relative size-4" />
                    <span className="relative">{t.label}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
              transition={{ duration: 0.3, ease: EASE_OUT }}
              className="flex flex-col gap-6"
            >
              {project.error ? <ErrorState error={project.error} onRetry={project.reload} /> : null}
              {tab === "general" ? <GeneralSection project={project.data} /> : null}
              {tab === "appearance" ? <AppearanceSection /> : null}
              {tab === "policy" ? (
                <PolicySection
                  project={project.data}
                  onSaved={(policy) => project.data && project.setData({ ...project.data, policy })}
                />
              ) : null}
              {tab === "session" ? <SessionSection /> : null}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </Page>
  )
}

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
      </div>
      <div className="flex min-w-0 items-center gap-1 text-sm sm:justify-end">{children}</div>
    </div>
  )
}

function GeneralSection({ project }: { project: Project | undefined }) {
  const session = useProject()
  const role = roleMeta(project?.role ?? session.role)
  const loading = (w: string) => <Skeleton className={cn("h-5", w)} />
  return (
    <Card>
      <CardHeader>
        <CardTitle>Project</CardTitle>
        <CardDescription>Details of the project this dashboard is signed in to.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col divide-y">
        <Row label="Project name">{project ? <span>{project.name}</span> : loading("w-28")}</Row>
        <Row label="Project ID" description="Used in API paths, logs and support requests.">
          <span className="truncate font-mono text-xs">{project?.id ?? session.id}</span>
          <CopyButton value={project?.id ?? session.id} label="Copy project ID" size="icon-xs" />
        </Row>
        <Row label="Your role" description={role?.description}>
          {role ? (
            <Badge variant={role.value === "admin" ? "default" : "secondary"}>
              <role.icon data-icon="inline-start" />
              {role.label}
            </Badge>
          ) : (
            <span>{session.role}</span>
          )}
        </Row>
        <Row label="API server" description="Requests from this dashboard go through its own proxy to this server.">
          <span className="truncate font-mono text-xs">{session.server}</span>
          <CopyButton value={session.server} label="Copy server URL" size="icon-xs" />
        </Row>
        <Row label="Created">
          {project ? <span className="text-muted-foreground tabular-nums">{formatDateTime(project.created_at)}</span> : loading("w-40")}
        </Row>
      </CardContent>
    </Card>
  )
}

function AppearanceSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Theme</CardTitle>
        <CardDescription>Choose how the console looks on this device.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ThemePreviewCards />
        <Separator />
        <div className="flex items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            <SparklesIcon className="size-4" />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Motion</span>
            <span className="text-xs text-muted-foreground">
              Animations follow your system&apos;s reduced-motion setting. Turn on &ldquo;Reduce motion&rdquo; in your OS accessibility settings to make
              transitions instant.
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function PolicySection({ project, onSaved }: { project: Project | undefined; onSaved: (policy: Record<string, unknown>) => void }) {
  const isAdmin = useCan("admin")
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Project policy
          {!isAdmin ? <Badge variant="muted">Read only</Badge> : null}
        </CardTitle>
        <CardDescription>
          Guardrails the server enforces for every agent in this project: which models, tools and agents are allowed, where tools may connect, and a
          token budget.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!project ? (
          <Skeleton className="h-80 w-full" />
        ) : isAdmin ? (
          <PolicyEditor policy={project.policy} onSaved={onSaved} />
        ) : (
          <div className="flex flex-col gap-3">
            <CodeBlock code={JSON.stringify(project.policy ?? {}, null, 2)} label="policy.json" />
            <p className="text-xs text-muted-foreground">Only admins can change the policy.</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Everything the console keeps in this browser's storage (theme, remembered names, view preferences). */
function forgetLocalData() {
  try {
    window.localStorage.clear()
    window.sessionStorage.clear()
  } catch {
    // Storage unavailable: nothing to forget.
  }
}

function SessionSection() {
  const project = useProject()
  const [pending, setPending] = React.useState<"signout" | "leave" | null>(null)
  const role = roleMeta(project.role)

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>This browser is signed in with an API key, kept server-side in an http-only cookie.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 rounded-lg bg-muted/40 p-3 ring-1 ring-foreground/8 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
                {project.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">
                  {project.name} <span className="font-normal text-muted-foreground">· {role?.label ?? project.role}</span>
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">{project.server}</span>
              </div>
            </div>
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() => {
                setPending("signout")
                void signOut()
              }}
            >
              {pending === "signout" ? <Spinner data-icon="inline-start" /> : <LogOutIcon data-icon="inline-start" />}
              Sign out
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="ring-destructive/25">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>Actions here affect this browser only. Your API key keeps working until an admin revokes it.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Leave dashboard</span>
              <span className="text-xs text-muted-foreground">
                Sign out and forget everything this browser remembers: theme, key names and other preferences.
              </span>
            </div>
            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="destructive" className="shrink-0" disabled={pending !== null} />}>
                <DoorOpenIcon data-icon="inline-start" />
                Leave dashboard
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogMedia className="bg-destructive/10 text-destructive">
                    <DoorOpenIcon />
                  </AlertDialogMedia>
                  <AlertDialogTitle>Leave the dashboard?</AlertDialogTitle>
                  <AlertDialogDescription>
                    You&apos;ll be signed out of <span className="font-medium text-foreground">{project.name}</span> and this browser&apos;s saved
                    preferences will be cleared. You can sign back in with any valid API key.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Stay</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={pending !== null}
                    onClick={() => {
                      setPending("leave")
                      forgetLocalData()
                      void signOut()
                    }}
                  >
                    {pending === "leave" ? <Spinner data-icon="inline-start" /> : null}
                    Leave dashboard
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
        <CardFooter className="border-t bg-muted/30 py-3 text-xs text-muted-foreground">
          To stop a key from working anywhere, revoke it on the API keys page.
        </CardFooter>
      </Card>
    </>
  )
}
