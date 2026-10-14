"use client"

import * as React from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { AnimatePresence, motion } from "motion/react"
import { ActivityIcon, ArrowUpRightIcon, CodeIcon, PlayIcon, SquareIcon, TextIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Page, PageHeader } from "@/components/page"
import { EASE_OUT, FadeIn } from "@/components/motion"
import { AgentArt } from "@/components/agent-art"
import { CodeBlock } from "@/components/code-block"
import { ErrorState } from "@/components/states"
import { useCan, useProject } from "@/components/shell/project-context"
import { RegisterAgentDialog } from "@/components/agents/register-agent-dialog"
import { useStoredChoice } from "@/components/agents/use-stored-choice"
import { RunOutput } from "@/components/playground/run-output"
import { LANGUAGE_LABELS, LANGUAGES, snippet, type Language } from "@/components/playground/snippets"
import { TemplateGrid } from "@/components/playground/template-grid"
import { TEMPLATES, type Template } from "@/components/playground/templates"
import { useAgentRun } from "@/components/playground/use-agent-run"
import { useApi } from "@/hooks/use-api"
import { describeTarget } from "@/lib/alias"
import type { AgentList, AgentVersion, AliasList } from "@/lib/api"
import { seg } from "@/lib/client"

const noop = () => () => {}

function useIsMac(): boolean {
  return React.useSyncExternalStore(
    noop,
    () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
    () => false
  )
}

export function PlaygroundView() {
  const params = useSearchParams()
  const project = useProject()
  const canRun = useCan("developer")
  const isMac = useIsMac()
  const agents = useApi<AgentList>("/v1/agents")
  const agentList = React.useMemo(() => agents.data?.agents ?? [], [agents.data])

  const paramAgent = params.get("agent")
  const paramTarget = params.get("target")
  const [agentChoice, setAgentChoice] = React.useState<string | null>(null)
  const agentName =
    [agentChoice, paramAgent].find((n) => n && agentList.some((a) => a.name === n)) ?? agentList[0]?.name ?? null
  const agent = agentList.find((a) => a.name === agentName) ?? null

  const aliases = useApi<AliasList>(agentName ? `/v1/agents/${seg(agentName)}/aliases` : null)
  const aliasList = React.useMemo(() => (aliases.data?.name === agentName ? aliases.data.aliases : []), [aliases.data, agentName])
  const versions = React.useMemo(
    () => (agent ? Array.from({ length: agent.latest_version }, (_, i) => agent.latest_version - i) : []),
    [agent]
  )

  const [targetChoice, setTargetChoice] = React.useState<{ agent: string; ref: string } | null>(null)
  const refOptions = React.useMemo(() => new Set(["latest", ...aliasList.map((a) => a.alias), ...versions.map(String)]), [aliasList, versions])
  const defaultRef =
    paramTarget && paramAgent === agentName && refOptions.has(paramTarget)
      ? paramTarget
      : aliasList.some((a) => a.alias === "prod")
        ? "prod"
        : "latest"
  const ref = targetChoice && targetChoice.agent === agentName && refOptions.has(targetChoice.ref) ? targetChoice.ref : defaultRef
  const target = agentName ? `${agentName}@${ref}` : ""

  // Templates register with the models the project already uses.
  const first = agentList[0]
  const firstSpec = useApi<AgentVersion>(first ? `/v1/agents/${seg(first.name)}/versions/${first.latest_version}` : null)
  const templateModels = React.useMemo(() => {
    const m = (firstSpec.data?.spec as { models?: unknown } | undefined)?.models
    return Array.isArray(m) && m.length && m.every((x) => typeof x === "string") ? (m as string[]) : ["claude-opus-5-5"]
  }, [firstSpec.data])

  const [input, setInput] = React.useState("")
  const [view, setView] = React.useState<"form" | "code">("form")
  const [lang, setLang] = useStoredChoice<Language>("playground.lang", LANGUAGES, "curl")
  const [template, setTemplate] = React.useState<Template | null>(null)
  const [lastTemplate, setLastTemplate] = React.useState<Template | null>(null)
  if (template && template !== lastTemplate) setLastTemplate(template)
  const shownTemplate = template ?? lastTemplate
  const textarea = React.useRef<HTMLTextAreaElement>(null)

  const { state, run, stop, reset } = useAgentRun()
  const running = state.phase === "starting" || state.phase === "streaming"
  const hasRun = state.phase !== "idle"
  const canSubmit = canRun && !!agentName && input.trim().length > 0 && !running

  function submit() {
    if (!canSubmit) return
    setView("form")
    void run(target, input.trim())
  }

  const onKey = React.useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !template) {
      e.preventDefault()
      submit()
    }
  })
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e)
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [])

  const code = snippet(lang, target || "my-agent@prod", input.trim(), project.server)

  return (
    <Page>
      <PageHeader
        title="Playground"
        description="Invoke any agent, watch its events stream in, then grab the same request as code."
        actions={
          <Button variant="outline" render={<Link href="/sessions" />}>
            <ActivityIcon data-icon="inline-start" />
            Sessions
          </Button>
        }
      />

      {agents.error ? <ErrorState error={agents.error} onRetry={agents.reload} /> : null}

      <FadeIn delay={0.05}>
        <Card className="gap-0 py-0">
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5 sm:px-4">
            {agents.loading && !agents.data ? (
              <>
                <Skeleton className="h-8 w-52" />
                <Skeleton className="h-8 w-32" />
              </>
            ) : (
              <>
                <Select
                  value={agentName}
                  onValueChange={(v) => {
                    if (!v) return
                    setAgentChoice(v)
                    setTargetChoice(null)
                  }}
                  disabled={!agentList.length}
                >
                  <SelectTrigger className="w-full min-w-0 sm:w-56" aria-label="Agent">
                    <SelectValue placeholder="No agents yet">
                      {(v: string | null) =>
                        v ? (
                          <span className="flex min-w-0 items-center gap-2">
                            <AgentArt name={v} className="size-4 shrink-0 rounded-full" />
                            <span className="truncate">{v}</span>
                          </span>
                        ) : (
                          "No agents yet"
                        )
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} align="start" className="min-w-64">
                    {agentList.map((a) => (
                      <SelectItem key={a.name} value={a.name}>
                        <AgentArt name={a.name} className="size-4 shrink-0 rounded-full" />
                        {a.name}
                        <span className="text-xs text-muted-foreground">v{a.latest_version}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={ref} onValueChange={(v) => v && agentName && setTargetChoice({ agent: agentName, ref: v })} disabled={!agentName}>
                  <SelectTrigger className="min-w-0 font-mono text-xs sm:w-40" aria-label="Alias or version">
                    <SelectValue>{(v: string) => (/^\d+$/.test(v) ? `v${v}` : `@${v}`)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} align="start" className="min-w-60">
                    {aliasList.length ? (
                      <SelectGroup>
                        <SelectLabel>Aliases</SelectLabel>
                        {aliasList.map((a) => (
                          <SelectItem key={a.alias} value={a.alias} className="font-mono text-xs">
                            @{a.alias}
                            <span className="text-muted-foreground">{describeTarget(a.versions)}</span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ) : null}
                    {aliasList.length ? <SelectSeparator /> : null}
                    <SelectGroup>
                      <SelectLabel>Versions</SelectLabel>
                      <SelectItem value="latest" className="font-mono text-xs">
                        @latest <span className="text-muted-foreground">v{agent?.latest_version}</span>
                      </SelectItem>
                      {versions.map((v) => (
                        <SelectItem key={v} value={String(v)} className="font-mono text-xs">
                          v{v}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {agent ? (
                  <Button variant="ghost" size="icon-sm" render={<Link href={`/agents/${seg(agent.name)}`} />} aria-label={`Open ${agent.name}`}>
                    <ArrowUpRightIcon />
                  </Button>
                ) : null}
              </>
            )}
            <Tabs value={view} onValueChange={(v) => setView(v as "form" | "code")} className="ml-auto">
              <TabsList>
                <TabsTrigger value="form" className="px-2.5">
                  <TextIcon />
                  Form
                </TabsTrigger>
                <TabsTrigger value="code" className="px-2.5">
                  <CodeIcon />
                  Code
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <AnimatePresence mode="wait" initial={false}>
            {view === "form" ? (
              <motion.div
                key="form"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col"
              >
                {agent?.description ? (
                  <p className="px-4 pt-3 text-xs text-muted-foreground">{agent.description}</p>
                ) : null}
                <label htmlFor="playground-input" className="sr-only">
                  Input
                </label>
                <textarea
                  id="playground-input"
                  ref={textarea}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={agentName ? `Ask ${agentName} something…` : "Register an agent or pick a template below to get started."}
                  className="min-h-44 w-full resize-y bg-transparent px-4 py-3 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/70 md:min-h-52"
                />
              </motion.div>
            ) : (
              <motion.div
                key="code"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col gap-3 p-4"
              >
                <CodeBlock
                  code={code}
                  className="min-h-44"
                  label={
                    <Select value={lang} onValueChange={(v) => v && setLang(v as Language)}>
                      <SelectTrigger size="sm" className="-ml-1.5 h-6 border-0 bg-transparent px-1.5 text-xs shadow-none dark:bg-transparent" aria-label="Language">
                        <SelectValue>{(v: Language) => LANGUAGE_LABELS[v]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent alignItemWithTrigger={false} align="start">
                        {LANGUAGES.map((l) => (
                          <SelectItem key={l} value={l} className="text-xs">
                            {LANGUAGE_LABELS[l]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Same request as the Run button: <span className="font-mono">POST /v1/agents/{target || "name@alias"}/invoke</span> with{" "}
                  <span className="font-mono">mode: &quot;async&quot;</span>, then the session&apos;s event stream.
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-3 py-2.5 sm:px-4">
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">
              {canRun ? (
                <>
                  Runs <span className="font-mono text-foreground">{target || "–"}</span> asynchronously and streams events
                </>
              ) : (
                "Viewer keys can browse but not invoke agents."
              )}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <AnimatePresence initial={false}>
                {running ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: 0.2, ease: EASE_OUT }}
                  >
                    <Button variant="outline" onClick={() => void stop()} disabled={state.stopping}>
                      {state.stopping ? <Spinner data-icon="inline-start" /> : <SquareIcon data-icon="inline-start" className="fill-current" />}
                      Stop
                    </Button>
                  </motion.div>
                ) : null}
              </AnimatePresence>
              <Button onClick={submit} disabled={!canSubmit} className="pr-1.5">
                {running ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" className="fill-current" />}
                {running ? "Running" : "Run"}
                <KbdGroup className="ml-1">
                  <Kbd className="bg-primary-foreground/15 text-primary-foreground/80">{isMac ? "⌘" : "Ctrl"}</Kbd>
                  <Kbd className="bg-primary-foreground/15 text-primary-foreground/80">↵</Kbd>
                </KbdGroup>
              </Button>
            </div>
          </div>
        </Card>
      </FadeIn>

      <AnimatePresence mode="popLayout" initial={false}>
        {hasRun ? (
          <motion.div
            key="output"
            initial={{ opacity: 0, y: 12, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.4, ease: EASE_OUT }}
          >
            <Card className="gap-0 py-0">
              <RunOutput state={state} onDismiss={reset} />
            </Card>
          </motion.div>
        ) : canRun ? (
          <motion.section
            key="templates"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.35, ease: EASE_OUT }}
            className="flex flex-col gap-3"
          >
            <div>
              <h2 className="text-sm font-semibold">Start with a template</h2>
              <p className="text-sm text-muted-foreground">Register a starter agent in one click, then run it here.</p>
            </div>
            <TemplateGrid templates={TEMPLATES} onPick={setTemplate} />
          </motion.section>
        ) : null}
      </AnimatePresence>

      {canRun ? (
        <RegisterAgentDialog
          open={template !== null}
          onOpenChange={(open) => !open && setTemplate(null)}
          initialSpec={shownTemplate ? JSON.stringify(shownTemplate.spec(templateModels), null, 2) : "{}"}
          title={shownTemplate ? `${shownTemplate.title} template` : "Template"}
          description={shownTemplate?.description}
          submitLabel="Register & select"
          header={
            shownTemplate ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {shownTemplate.features.map((f) => (
                  <Badge key={f} variant="muted" className="rounded-md font-normal">
                    {f}
                  </Badge>
                ))}
                <span className="text-xs text-muted-foreground">· edit the spec before registering if you like</span>
              </div>
            ) : null
          }
          onRegistered={(r) => {
            setAgentChoice(r.name)
            setTargetChoice({ agent: r.name, ref: "latest" })
            if (!input.trim() && shownTemplate) setInput(shownTemplate.sample)
            setTemplate(null)
            agents.reload()
            requestAnimationFrame(() => textarea.current?.focus())
          }}
        />
      ) : null}
    </Page>
  )
}
