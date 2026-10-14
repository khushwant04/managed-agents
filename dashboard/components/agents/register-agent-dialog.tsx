"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { CircleAlertIcon } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { EASE_OUT } from "@/components/motion"
import { checkSpec, SpecEditor } from "@/components/agents/spec-editor"
import { useMutation } from "@/hooks/use-api"
import { isErrorBody, type RegisterResult } from "@/lib/api"
import { api, ApiError } from "@/lib/client"

export function exampleSpec(model = "claude-opus-5-5"): string {
  return JSON.stringify(
    {
      name: "docs-helper",
      description: "Answers questions about the product docs and links its sources.",
      models: [model],
      instructions: "You are a concise, friendly assistant. Answer from the docs and cite the pages you used.",
      tools: [{ type: "builtin", name: "web_fetch" }],
      limits: { max_steps: 30 },
      tags: ["docs", "support"],
    },
    null,
    2
  )
}

/** Problems from a 422, or the plain message for any other failure. */
function problemsOf(e: unknown): string[] {
  if (e instanceof ApiError && isErrorBody(e.body) && e.body.problems?.length) return e.body.problems
  return [e instanceof Error ? e.message : String(e)]
}

function RegisterForm({
  initialSpec,
  submitLabel,
  onDone,
  onCancel,
}: {
  initialSpec: string
  submitLabel: string
  onDone: (r: RegisterResult) => void
  onCancel: () => void
}) {
  const [text, setText] = React.useState(initialSpec)
  const [problems, setProblems] = React.useState<string[]>([])
  const check = React.useMemo(() => checkSpec(text), [text])
  const { pending, run } = useMutation()

  async function submit() {
    if (!check.spec || check.error) return
    setProblems([])
    const result = await run(async () => {
      try {
        return await api<RegisterResult>("/v1/agents", { method: "POST", json: check.spec })
      } catch (e) {
        setProblems(problemsOf(e))
        throw e
      }
    })
    if (!result) return
    toast.success(
      result.created ? `Registered ${result.name} v${result.version}` : `${result.name} v${result.version} is unchanged`,
      { description: result.created ? `Hash ${result.hash.slice(0, 12)}` : "The spec matches the latest version." }
    )
    onDone(result)
  }

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void submit()
        }
      }}
    >
      <SpecEditor
        id="agent-spec"
        value={text}
        onChange={(v) => {
          setText(v)
          if (problems.length) setProblems([])
        }}
        check={check}
        className="h-[min(26rem,55vh)]"
        autoFocus
      />
      <AnimatePresence initial={false}>
        {problems.length ? (
          <motion.div
            key="problems"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div role="alert" className="flex gap-2.5 rounded-lg bg-destructive/6 p-3 text-sm ring-1 ring-destructive/20">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="flex min-w-0 flex-col gap-1">
                <p className="font-medium text-destructive">
                  The server rejected this spec{problems.length > 1 ? ` (${problems.length} problems)` : ""}
                </p>
                <ul className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
                  {problems.map((p, i) => (
                    <li key={i} className="break-words">
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !!check.error}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Register (or re-register) an agent from a JSON spec. */
export function RegisterAgentDialog({
  open,
  onOpenChange,
  initialSpec,
  onRegistered,
  title = "Register agent",
  description,
  submitLabel = "Register",
  header,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialSpec: string
  onRegistered: (r: RegisterResult) => void
  title?: React.ReactNode
  description?: React.ReactNode
  submitLabel?: string
  /** Extra content above the editor (e.g. a template summary). */
  header?: React.ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ?? (
              <>
                Paste an <code className="font-mono text-xs">AgentSpec</code> as JSON. Registering an existing name adds a
                new version; an identical spec is a no-op.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {header}
        <RegisterForm
          initialSpec={initialSpec}
          submitLabel={submitLabel}
          onCancel={() => onOpenChange(false)}
          onDone={onRegistered}
        />
      </DialogContent>
    </Dialog>
  )
}
