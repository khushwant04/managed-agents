export const LANGUAGES = ["curl", "python", "typescript"] as const
export type Language = (typeof LANGUAGES)[number]

export const LANGUAGE_LABELS: Record<Language, string> = {
  curl: "cURL",
  python: "Python",
  typescript: "TypeScript",
}

/** The playground's request as code, for `target` (`name@alias`) and `input`. */
export function snippet(lang: Language, target: string, input: string, baseUrl: string): string {
  const text = input || "Hello!"
  const literal = JSON.stringify(text)
  switch (lang) {
    case "curl": {
      const body = JSON.stringify({ input: text, mode: "async" }).replaceAll("'", "'\\''")
      return [
        `curl ${baseUrl.replace(/\/$/, "")}/v1/agents/${encodeURIComponent(target).replace("%40", "@")}/invoke \\`,
        `  -H "Authorization: Bearer $AGENTS_API_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '${body}'`,
        ``,
        `# then follow the events:`,
        `# curl -N ${baseUrl.replace(/\/$/, "")}/v1/sessions/<session_id>/stream?until_settled=true \\`,
        `#   -H "Authorization: Bearer $AGENTS_API_KEY"`,
      ].join("\n")
    }
    case "python":
      return [
        `from agents import Client`,
        ``,
        `client = Client()  # reads AGENTS_BASE_URL and AGENTS_API_KEY`,
        ``,
        `session = client.invoke(${JSON.stringify(target)}, ${literal})`,
        `for ev in session.events():`,
        `    if ev.type == "message.agent.delta":`,
        `        print(ev.text, end="", flush=True)`,
      ].join("\n")
    case "typescript":
      return [
        `import { Client } from "@managed-agents/client"`,
        ``,
        `const client = new Client() // reads AGENTS_BASE_URL and AGENTS_API_KEY`,
        ``,
        `const session = await client.invoke(${JSON.stringify(target)}, {`,
        `  input: ${literal},`,
        `})`,
        `for await (const ev of session.events()) {`,
        `  if (ev.type === "message.agent.delta") process.stdout.write(ev.text)`,
        `}`,
      ].join("\n")
  }
}
