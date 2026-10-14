"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CodeBlock } from "@/components/code-block"
import { EASE_OUT } from "@/components/motion"
import { PROVIDER_ICON } from "@/components/deploy/trigger-chip"
import { PROVIDER_LABEL, PROVIDER_SIGNING, PROVIDERS, type WebhookProvider } from "@/lib/triggers"

function snippet(provider: WebhookProvider, url: string): string | null {
  if (provider !== "generic") return null
  return [
    `ts=$(date +%s)`,
    `body='{"ticket": 4182, "summary": "Checkout is down"}'`,
    `sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')`,
    ``,
    `curl -X POST ${url} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "X-Agents-Event: ticket.created" \\`,
    `  -H "X-Agents-Signature: t=$ts,v1=$sig" \\`,
    `  -d "$body"`,
  ].join("\n")
}

/** Per-provider notes on how deliveries are signed and verified. */
export function SigningHelp({ exampleUrl }: { exampleUrl: string }) {
  const [provider, setProvider] = React.useState<WebhookProvider>("github")
  const info = PROVIDER_SIGNING[provider]
  const code = snippet(provider, exampleUrl)
  return (
    <Card>
      <CardHeader>
        <CardTitle>How signing works</CardTitle>
        <CardDescription>
          Every delivery is verified with the deployment&apos;s signing secret before a session starts. Unsigned or stale
          requests get a 401.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Tabs value={provider} onValueChange={(v) => setProvider(v as WebhookProvider)}>
          <TabsList variant="line" className="w-full justify-start overflow-x-auto">
            {PROVIDERS.map((p) => {
              const Icon = PROVIDER_ICON[p]
              return (
                <TabsTrigger key={p} value={p} className="flex-none">
                  <Icon />
                  {PROVIDER_LABEL[p]}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={provider}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="flex flex-col gap-4"
          >
            <p className="text-sm text-muted-foreground">{info.setup}</p>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[9rem_1fr]">
              <dt className="text-xs text-muted-foreground sm:pt-0.5">Signature header</dt>
              <dd className="font-mono text-xs">{info.header}</dd>
              <dt className="text-xs text-muted-foreground sm:pt-0.5">Scheme</dt>
              <dd className="font-mono text-xs break-all">{info.scheme}</dd>
              <dt className="text-xs text-muted-foreground sm:pt-0.5">Event name</dt>
              <dd className="text-xs">{info.event}</dd>
            </dl>
            {code ? <CodeBlock code={code} label="Send a signed event with curl" /> : null}
          </motion.div>
        </AnimatePresence>
      </CardContent>
    </Card>
  )
}
