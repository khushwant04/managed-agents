"use client"

import * as React from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CodeBlock } from "@/components/code-block"
import { useProject } from "@/components/shell/project-context"

function snippets(server: string) {
  const base = server.replace(/\/+$/, "")
  return {
    curl: `export AGENTS_API_KEY="ak_..."

# List the agents in this project
curl ${base}/v1/agents \\
  -H "Authorization: Bearer $AGENTS_API_KEY"

# Invoke one and stream its events
curl -N ${base}/v1/agents/incident-investigator@prod/invoke \\
  -H "Authorization: Bearer $AGENTS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"input": "5xx spike on service-api", "stream": true}'`,
    python: `from agents import Client

client = Client(base_url="${base}")  # reads AGENTS_API_KEY

session = client.invoke("incident-investigator@prod", input="5xx spike on service-api")
for ev in session.events():
    if ev.type == "message.agent.delta":
        print(ev.text, end="")`,
    typescript: `import { Client } from "@managed-agents/client"

const client = new Client({ baseURL: "${base}" }) // apiKey defaults to AGENTS_API_KEY

const session = await client.invoke("incident-investigator@prod", { input: "5xx spike on service-api" })
for await (const ev of session.events()) {
  if (ev.type === "message.agent.delta") process.stdout.write(ev.text)
}`,
  }
}

/** "Using your key" card: cURL / Python / TypeScript against this server. */
export function KeySnippets() {
  const { server } = useProject()
  const code = React.useMemo(() => snippets(server), [server])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Using your key</CardTitle>
        <CardDescription>
          Send it as a bearer token. The SDKs read <code className="font-mono text-xs text-foreground">AGENTS_API_KEY</code> from the environment.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="curl" className="gap-3">
          <TabsList variant="line">
            <TabsTrigger value="curl">cURL</TabsTrigger>
            <TabsTrigger value="python">Python</TabsTrigger>
            <TabsTrigger value="typescript">TypeScript</TabsTrigger>
          </TabsList>
          <TabsContent value="curl">
            <CodeBlock code={code.curl} label="shell" />
          </TabsContent>
          <TabsContent value="python">
            <CodeBlock code={code.python} label="python" />
          </TabsContent>
          <TabsContent value="typescript">
            <CodeBlock code={code.typescript} label="typescript" />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
