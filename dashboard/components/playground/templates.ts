import {
  BookOpenTextIcon,
  ChartNoAxesCombinedIcon,
  GitPullRequestIcon,
  type LucideIcon,
  NetworkIcon,
  SirenIcon,
  SparklesIcon,
} from "lucide-react"

export interface Template {
  id: string
  title: string
  description: string
  icon: LucideIcon
  features: string[]
  /** A first prompt to try once it is registered. */
  sample: string
  spec: (models: string[]) => Record<string, unknown>
}

/** Starter agents for the playground; each one registers as a plain AgentSpec. */
export const TEMPLATES: Template[] = [
  {
    id: "hello",
    title: "Minimal assistant",
    description: "A plain chat agent with no tools. The quickest way to see a run end to end.",
    icon: SparklesIcon,
    features: ["chat", "streaming"],
    sample: "ping",
    spec: (models) => ({
      name: "hello-agent",
      description: "A friendly assistant with no tools.",
      models,
      instructions: "You are a friendly, concise assistant. Answer in one or two sentences.",
      tags: ["template", "starter"],
    }),
  },
  {
    id: "incident",
    title: "Incident investigator",
    description: "Runs shell commands in a sandbox to triage alerts; risky commands wait for approval.",
    icon: SirenIcon,
    features: ["shell", "approvals", "web fetch"],
    sample: "p99 latency on checkout jumped at 14:05 UTC. What changed?",
    spec: (models) => ({
      name: "incident-triage",
      description: "Investigates alerts and writes a short root-cause report.",
      models,
      instructions:
        "You are an on-call SRE. Gather evidence before concluding: check recent deploys, logs and metrics. End with a root cause, impact and next steps.",
      tools: [
        { type: "builtin", name: "shell", approval: "always" },
        { type: "builtin", name: "web_fetch" },
      ],
      limits: { max_steps: 40 },
      tags: ["template", "sre"],
    }),
  },
  {
    id: "research",
    title: "Web researcher",
    description: "Searches the web, reads the best sources and answers with citations.",
    icon: BookOpenTextIcon,
    features: ["web search", "web fetch"],
    sample: "Summarise the trade-offs between SSE and WebSockets for streaming agent events.",
    spec: (models) => ({
      name: "web-researcher",
      description: "Answers questions from the web with citations.",
      models,
      instructions: "Search first, read at least two sources, then answer in a short brief with numbered citations.",
      tools: [
        { type: "builtin", name: "web_search" },
        { type: "builtin", name: "web_fetch" },
      ],
      tags: ["template", "research"],
    }),
  },
  {
    id: "reviewer",
    title: "PR reviewer",
    description: "Reads a diff with file tools and leaves prioritised, evidence-backed comments.",
    icon: GitPullRequestIcon,
    features: ["files", "code"],
    sample: "Review this change: the retry loop now sleeps 2**attempt seconds with no cap.",
    spec: (models) => ({
      name: "pr-reviewer",
      description: "Reviews diffs for bugs, security issues and style.",
      models,
      instructions: "Review for correctness first, then security, then style. Quote the lines you comment on.",
      tools: [
        { type: "builtin", name: "files" },
        { type: "builtin", name: "code" },
      ],
      tags: ["template", "review"],
    }),
  },
  {
    id: "analyst",
    title: "Data analyst",
    description: "Writes and runs Python in a sandbox to answer questions over CSVs.",
    icon: ChartNoAxesCombinedIcon,
    features: ["code", "files", "sandbox"],
    sample: "Load sales.csv and tell me which region grew fastest last quarter.",
    spec: (models) => ({
      name: "csv-analyst",
      description: "Answers questions over CSV files with Python.",
      models,
      instructions: "Use Python to inspect the data before answering. Show the key numbers and how you got them.",
      tools: [
        { type: "builtin", name: "code" },
        { type: "builtin", name: "files" },
      ],
      limits: { max_steps: 60, max_wall_clock_s: 600 },
      tags: ["template", "analytics"],
    }),
  },
  {
    id: "orchestrator",
    title: "Orchestrator",
    description: "Splits a task into parts and delegates them to parallel subagents.",
    icon: NetworkIcon,
    features: ["subagents", "web search"],
    sample: "Compare three hosted vector databases on price, latency and limits.",
    spec: (models) => ({
      name: "orchestrator",
      description: "Plans, delegates to subagents and merges their results.",
      models,
      instructions: "Break the task into independent parts, run them as subagents in parallel, then merge the results.",
      tools: [{ type: "builtin", name: "web_search" }],
      subagents: { max_concurrent: 3, max_depth: 1 },
      tags: ["template", "multi-agent"],
    }),
  },
]
