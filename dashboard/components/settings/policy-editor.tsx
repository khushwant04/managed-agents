"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { AlertCircleIcon, CheckCircle2Icon, PlusIcon, TriangleAlertIcon, WandSparklesIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EASE_OUT } from "@/components/motion"
import { useMutation } from "@/hooks/use-api"
import type { PolicyResult } from "@/lib/api"
import { api } from "@/lib/client"
import { checkPolicy, POLICY_KEYS, withPolicyKey } from "@/lib/policy"
import { cn } from "@/lib/utils"

const pretty = (v: unknown) => JSON.stringify(v ?? {}, null, 2)

/** JSON editor for the project policy with live validation and a key reference. */
export function PolicyEditor({
  policy,
  onSaved,
}: {
  policy: Record<string, unknown>
  onSaved: (policy: Record<string, unknown>) => void
}) {
  const saved = pretty(policy)
  const [draft, setDraft] = React.useState<string | null>(null)
  const text = draft ?? saved
  const check = React.useMemo(() => checkPolicy(text), [text])
  const dirty = draft !== null && (check.policy ? pretty(check.policy) !== saved : true)
  const m = useMutation()
  const area = React.useRef<HTMLTextAreaElement>(null)

  const save = async () => {
    if (!check.policy || !dirty || m.pending) return
    const res = await m.run(() => api<PolicyResult>("/v1/project/policy", { method: "PUT", json: check.policy }))
    if (res) {
      onSaved(res.policy)
      setDraft(null)
      toast.success("Policy saved", { description: "New runs and registrations use it right away." })
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault()
      void save()
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart: a, selectionEnd: b } = el
      const next = `${text.slice(0, a)}  ${text.slice(b)}`
      setDraft(next)
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
    }
  }

  const present = new Set(Object.keys(check.policy ?? {}))

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_17rem]">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="relative">
          <Textarea
            ref={area}
            value={text}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            aria-label="Policy JSON"
            aria-invalid={!!check.error}
            className="min-h-80 resize-y bg-muted/30 font-mono text-xs leading-relaxed md:text-xs"
          />
          <AnimatePresence>
            {dirty ? (
              <motion.span
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className="absolute top-2.5 right-2.5 rounded-full bg-warning/14 px-2 py-0.5 text-[11px] font-medium text-warning"
              >
                Unsaved
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={check.error ? "error" : check.warnings.length ? "warn" : "ok"}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="text-xs"
            aria-live="polite"
          >
            {check.error ? (
              <p className="flex items-start gap-1.5 text-destructive">
                <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
                {check.error}
              </p>
            ) : check.warnings.length ? (
              <ul className="flex flex-col gap-1 text-warning">
                {check.warnings.map((w) => (
                  <li key={w} className="flex items-start gap-1.5">
                    <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
                    <span className="text-muted-foreground">{w}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-1.5 text-success">
                <CheckCircle2Icon className="size-3.5" />
                <span className="text-muted-foreground">
                  Valid policy{present.size ? ` · ${present.size} ${present.size === 1 ? "rule" : "rules"}` : " · no restrictions"}
                </span>
              </p>
            )}
          </motion.div>
        </AnimatePresence>

        {m.error ? <p className="text-sm text-destructive">{m.error}</p> : null}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button onClick={save} disabled={!dirty || !check.policy || m.pending}>
            {m.pending ? <Spinner data-icon="inline-start" /> : null}
            Save policy
          </Button>
          <Button
            variant="outline"
            disabled={!check.policy}
            onClick={() => check.policy && setDraft(pretty(check.policy))}
          >
            <WandSparklesIcon data-icon="inline-start" />
            Format
          </Button>
          <Button variant="ghost" disabled={draft === null} onClick={() => setDraft(null)}>
            Discard changes
          </Button>
          <span className="ml-auto hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
            <Kbd>⌘</Kbd>
            <Kbd>S</Kbd>
            to save
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Keys the server reads</h3>
        <ul className="flex flex-col gap-1">
          {POLICY_KEYS.map((k) => {
            const has = present.has(k.key)
            return (
              <li key={k.key} className="group/key flex items-start gap-2 rounded-lg p-2 transition-colors hover:bg-muted/60">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <code className={cn("font-mono text-xs font-medium", has && "text-foreground")}>{k.key}</code>
                    {has ? <span className="size-1.5 rounded-full bg-success" aria-label="set" /> : null}
                  </div>
                  <code className="font-mono text-[11px] text-muted-foreground">{k.shape}</code>
                  <p className="text-xs text-muted-foreground">{k.description}</p>
                </div>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Add ${k.key}`}
                        disabled={has || !check.policy}
                        className="opacity-60 transition-opacity group-hover/key:opacity-100 disabled:opacity-0"
                        onClick={() => {
                          const next = withPolicyKey(text, k.key)
                          if (next) {
                            setDraft(next)
                            area.current?.focus()
                          }
                        }}
                      />
                    }
                  >
                    <PlusIcon />
                  </TooltipTrigger>
                  <TooltipContent>Add with an example value</TooltipContent>
                </Tooltip>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
