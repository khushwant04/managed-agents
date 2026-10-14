"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { CheckCircle2Icon, CircleAlertIcon, WandSparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface SpecCheck {
  spec: Record<string, unknown> | null
  /** The first problem found, or null when the spec looks registrable. */
  error: string | null
  summary: string | null
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

/** Client-side checks before the server validates the spec for real. */
export function checkSpec(text: string): SpecCheck {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    return { spec: null, error: e instanceof Error ? e.message : "invalid JSON", summary: null }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { spec: null, error: "the spec must be a JSON object", summary: null }
  }
  const spec = value as Record<string, unknown>
  const fail = (error: string): SpecCheck => ({ spec, error, summary: null })
  if (typeof spec.name !== "string" || !spec.name) return fail("\"name\" is required")
  if (!NAME.test(spec.name)) return fail("\"name\" uses lowercase letters, digits and dashes (max 63)")
  if (!Array.isArray(spec.models) || spec.models.length === 0) return fail("\"models\" needs at least one model")
  if (spec.models.some((m) => typeof m !== "string" || !m)) return fail("\"models\" must be a list of model names")
  if (spec.tools !== undefined && !Array.isArray(spec.tools)) return fail("\"tools\" must be a list")
  const tools = Array.isArray(spec.tools) ? spec.tools.length : 0
  const models = spec.models.length
  return {
    spec,
    error: null,
    summary: `${spec.name} · ${models} model${models === 1 ? "" : "s"} · ${tools} tool${tools === 1 ? "" : "s"}`,
  }
}

/** Monospace JSON editor with a line gutter, a format button and live validation. */
export function SpecEditor({
  value,
  onChange,
  check,
  className,
  id,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  check: SpecCheck
  className?: string
  id?: string
  autoFocus?: boolean
}) {
  const gutter = React.useRef<HTMLDivElement>(null)
  const lines = value.split("\n").length

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-input bg-muted/30 transition-[border-color,box-shadow] duration-200 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/20",
        check.error && check.spec === null && "border-destructive/60 focus-within:border-destructive focus-within:ring-destructive/20",
        className
      )}
    >
      <div className="flex min-h-0 flex-1">
        <div
          ref={gutter}
          aria-hidden
          className="w-10 shrink-0 overflow-hidden border-r bg-muted/40 py-2.5 pr-2 text-right font-mono text-xs leading-5 text-muted-foreground/60 select-none"
        >
          {Array.from({ length: lines }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <textarea
          id={id}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop
          }}
          onKeyDown={(e) => {
            if (e.key !== "Tab" || e.shiftKey) return
            e.preventDefault()
            const el = e.currentTarget
            const { selectionStart: s, selectionEnd: end } = el
            onChange(value.slice(0, s) + "  " + value.slice(end))
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2))
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-invalid={check.error ? true : undefined}
          className="min-h-0 flex-1 resize-none bg-transparent px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre outline-none"
        />
      </div>
      <div className="flex h-9 items-center gap-2 border-t bg-background/60 px-2.5 text-xs">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={check.error ? "err" : "ok"}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5",
              check.error ? "text-destructive" : "text-muted-foreground"
            )}
            aria-live="polite"
          >
            {check.error ? (
              <CircleAlertIcon className="size-3.5 shrink-0" />
            ) : (
              <CheckCircle2Icon className="size-3.5 shrink-0 text-success" />
            )}
            <span className="truncate">{check.error ?? check.summary}</span>
          </motion.span>
        </AnimatePresence>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={check.spec === null}
          onClick={() => check.spec && onChange(JSON.stringify(check.spec, null, 2))}
        >
          <WandSparklesIcon data-icon="inline-start" />
          Format
        </Button>
      </div>
    </div>
  )
}
