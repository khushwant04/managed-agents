"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ArrowRightIcon, EyeIcon, EyeOffIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { LogoMark } from "@/components/logo"
import { ThemeSegmented } from "@/components/theme-toggle"
import { EASE_OUT } from "@/components/motion"
import { errorMessage } from "@/lib/client"

const FEATURES = [
  "Versioned agents with movable aliases and canaries",
  "Durable runs that survive worker restarts",
  "Live timelines, approvals and replay",
]

export function SignInForm({
  defaultUrl,
  allowed,
  next,
  expired,
}: {
  defaultUrl: string
  allowed: string[]
  next: string
  expired: boolean
}) {
  const [apiKey, setApiKey] = React.useState("")
  const [show, setShow] = React.useState(false)
  const [serverUrl, setServerUrl] = React.useState(defaultUrl)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const res = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, serverUrl: serverUrl === defaultUrl ? "" : serverUrl }),
      })
      if (!res.ok) {
        setError(errorMessage(res.status, await res.json().catch(() => null)))
        return
      }
      window.location.assign(next)
    } catch {
      setError("could not reach the dashboard server")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="relative grid min-h-svh lg:grid-cols-[1fr_1.1fr]">
      <div className="absolute top-4 right-4 z-10">
        <ThemeSegmented />
      </div>
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: EASE_OUT }}
          className="mx-auto flex w-full max-w-sm flex-col gap-8"
        >
          <div className="flex flex-col gap-4">
            <LogoMark />
            <div className="flex flex-col gap-1.5">
              <h1 className="text-2xl font-semibold tracking-tight">Sign in to Runhive</h1>
              <p className="text-sm text-muted-foreground">
                Use a project API key. It stays in an httpOnly cookie on this dashboard&apos;s server and never reaches the page.
              </p>
            </div>
          </div>

          <AnimatePresence initial={false}>
            {expired || error ? (
              <motion.div
                key={error ?? "expired"}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3, ease: EASE_OUT }}
                className="overflow-hidden"
              >
                <div
                  role={error ? "alert" : "status"}
                  className={
                    error
                      ? "flex gap-2 rounded-lg bg-destructive/8 p-3 text-sm text-destructive ring-1 ring-destructive/20"
                      : "flex gap-2 rounded-lg bg-warning/10 p-3 text-sm text-warning ring-1 ring-warning/25"
                  }
                >
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                  {error ?? "Your session ended or the key is no longer valid. Sign in again."}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <form onSubmit={submit} noValidate>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="api-key">API key</FieldLabel>
                <InputGroup className="h-10">
                  <InputGroupInput
                    id="api-key"
                    name="api-key"
                    type={show ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    required
                    placeholder="ak_…"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoFocus
                    className="font-mono"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      aria-label={show ? "Hide key" : "Show key"}
                      onClick={() => setShow((s) => !s)}
                    >
                      {show ? <EyeOffIcon /> : <EyeIcon />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor="server-url">Server</FieldLabel>
                {allowed.length > 1 ? (
                  <Select value={serverUrl} onValueChange={(v) => v && setServerUrl(v)}>
                    <SelectTrigger id="server-url" className="w-full font-mono text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {allowed.map((u) => (
                        <SelectItem key={u} value={u} className="font-mono text-xs">
                          {u}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input id="server-url" value={serverUrl} readOnly aria-readonly="true" className="font-mono text-xs text-muted-foreground" />
                )}
                <FieldDescription>
                  {allowed.length > 1 ? "One of the servers this dashboard allows." : "Set by RUNHIVE_API_URL."}
                </FieldDescription>
              </Field>
              <Button type="submit" size="lg" className="h-10 w-full" disabled={pending || !apiKey.trim()}>
                {pending ? <Spinner /> : null}
                {pending ? "Checking key…" : "Continue"}
                {!pending ? <ArrowRightIcon data-icon="inline-end" className="transition-transform group-hover/button:translate-x-0.5" /> : null}
              </Button>
            </FieldGroup>
          </form>

          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheckIcon className="size-3.5" />
            Create keys with <code className="rounded bg-muted px-1 py-0.5 text-[11px]">runhive keys create</code> or the API keys page.
          </p>
        </motion.div>
      </div>

      <div className="relative hidden overflow-hidden bg-sidebar lg:block">
        <div className="bg-grid absolute inset-0" aria-hidden />
        <motion.div
          aria-hidden
          className="absolute -top-1/4 -right-1/4 size-[70%] rounded-full bg-[radial-gradient(circle,oklch(0.75_0.12_264/0.35),transparent_65%)] blur-2xl"
          animate={{ x: [0, -40, 0], y: [0, 30, 0] }}
          transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          aria-hidden
          className="absolute -bottom-1/4 -left-1/4 size-[70%] rounded-full bg-[radial-gradient(circle,oklch(0.8_0.12_155/0.3),transparent_65%)] blur-2xl"
          animate={{ x: [0, 40, 0], y: [0, -30, 0] }}
          transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
        />
        <div className="relative flex h-full flex-col justify-end gap-6 p-12">
          <SessionPreview />
          <ul className="flex flex-col gap-2">
            {FEATURES.map((f, i) => (
              <motion.li
                key={f}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.5 + i * 0.12, duration: 0.5, ease: EASE_OUT }}
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <span className="size-1.5 rounded-full bg-foreground/40" />
                {f}
              </motion.li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

const PREVIEW = [
  { t: "route.resolved", d: "incident-investigator@prod → v4" },
  { t: "tool.call", d: "shell · kubectl get pods -n api" },
  { t: "tool.result", d: "3 pods CrashLoopBackOff" },
  { t: "message.agent", d: "Rollback of deploy 8f2c fixed the 5xx spike." },
]

/** A decorative, self-playing session timeline. */
function SessionPreview() {
  return (
    <div className="max-w-md rounded-xl bg-background/70 p-4 shadow-elevated ring-1 ring-foreground/10 backdrop-blur-md">
      <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-mono">sess_7f3a…</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-info opacity-60" />
            <span className="relative size-1.5 rounded-full bg-info" />
          </span>
          running
        </span>
      </div>
      <ol className="flex flex-col gap-2.5">
        {PREVIEW.map((row, i) => (
          <motion.li
            key={row.t}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 + i * 0.35, duration: 0.5, ease: EASE_OUT }}
            className="flex items-start gap-3"
          >
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/30" />
            <div className="flex min-w-0 flex-col">
              <span className="font-mono text-[11px] text-muted-foreground">{row.t}</span>
              <span className="truncate text-sm">{row.d}</span>
            </div>
          </motion.li>
        ))}
      </ol>
    </div>
  )
}
