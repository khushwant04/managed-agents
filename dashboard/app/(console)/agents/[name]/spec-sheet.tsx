"use client"

import * as React from "react"
import { RocketIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CodeBlock } from "@/components/code-block"
import { CopyButton } from "@/components/copy-button"
import { ErrorState } from "@/components/states"
import { useApi } from "@/hooks/use-api"
import { aliasesForVersion } from "@/lib/alias"
import type { AgentVersion, AliasInfo } from "@/lib/api"
import { seg } from "@/lib/client"
import { formatDateTime, toDisplay } from "@/lib/format"
import type { AliasActions } from "./agent-view"

/** A version's full spec and agent card, in a side sheet. */
export function SpecSheet({
  name,
  version,
  onClose,
  aliases,
  actions,
}: {
  name: string
  version: number | null
  onClose: () => void
  aliases: AliasInfo[]
  actions: AliasActions
}) {
  // Keep showing the last version while the sheet slides out.
  const [last, setLast] = React.useState(version)
  if (version !== null && version !== last) setLast(version)
  const shown = version ?? last
  const { data, error, reload } = useApi<AgentVersion>(shown !== null ? `/v1/agents/${seg(name)}/versions/${shown}` : null)
  const ready = data && data.version === shown
  const serving = shown !== null ? aliasesForVersion(aliases, shown) : []

  return (
    <Sheet open={version !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            {name} <span className="font-mono text-muted-foreground">v{shown}</span>
            {serving.map((a) => (
              <Badge key={a.alias} variant="info" className="font-mono">
                @{a.alias}
                {a.weight !== 100 ? ` ${a.weight}%` : ""}
              </Badge>
            ))}
          </SheetTitle>
          <SheetDescription>The registered definition. Versions are immutable; register again to change it.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {error ? <ErrorState error={error} onRetry={reload} /> : null}
          {!ready && !error ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-16" />
              <Skeleton className="h-80" />
            </div>
          ) : null}
          {ready ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg bg-muted/40 p-3 text-sm ring-1 ring-foreground/6">
                <dt className="text-muted-foreground">Hash</dt>
                <dd className="flex min-w-0 items-center gap-1 font-mono text-xs">
                  <span className="truncate">{data.hash}</span>
                  <CopyButton value={data.hash} size="icon-xs" label="Copy hash" />
                </dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd>{formatDateTime(data.created_at)}</dd>
                <dt className="text-muted-foreground">By</dt>
                <dd className="truncate font-mono text-xs leading-5">{data.created_by ?? "–"}</dd>
              </dl>
              <Tabs defaultValue="spec">
                <TabsList>
                  <TabsTrigger value="spec">Spec</TabsTrigger>
                  <TabsTrigger value="card">Agent card</TabsTrigger>
                </TabsList>
                <TabsContent value="spec">
                  <CodeBlock code={toDisplay(data.spec)} label="spec.json" className="[&_pre]:max-h-none" />
                </TabsContent>
                <TabsContent value="card">
                  <CodeBlock code={toDisplay(data.card)} label="card.json" className="[&_pre]:max-h-none" />
                </TabsContent>
              </Tabs>
            </>
          ) : null}
        </div>
        {actions.canWrite && shown !== null ? (
          <SheetFooter className="flex-row justify-end border-t">
            <Button
              variant="outline"
              onClick={() => {
                onClose()
                actions.edit({ version: shown, mode: "split" })
              }}
            >
              Canary…
            </Button>
            <Button
              onClick={() => {
                onClose()
                actions.edit({ version: shown, mode: "single" })
              }}
            >
              <RocketIcon data-icon="inline-start" />
              Promote v{shown}
            </Button>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
