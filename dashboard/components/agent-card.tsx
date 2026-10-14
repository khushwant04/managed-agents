import Link from "next/link"
import { ArrowUpRightIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { AgentArt } from "@/components/agent-art"
import type { AgentSummary } from "@/lib/api"
import { cn } from "@/lib/utils"

/** Colourful agent tile, after the model cards on the Claude Console home. */
export function AgentCard({ agent, className }: { agent: AgentSummary; className?: string }) {
  const tags = agent.tags ?? []
  return (
    <Link
      href={`/agents/${encodeURIComponent(agent.name)}`}
      className={cn(
        "group/agent flex flex-col overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-foreground/10 transition-[box-shadow,transform] duration-300 ease-(--ease-out-quint) hover:-translate-y-0.5 hover:shadow-card-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className
      )}
    >
      <AgentArt name={agent.name} className="h-24" />
      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-medium">{agent.name}</div>
            <div className="text-xs text-muted-foreground">v{agent.latest_version}</div>
          </div>
          <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground opacity-0 transition-all duration-300 group-hover/agent:translate-x-0.5 group-hover/agent:-translate-y-0.5 group-hover/agent:opacity-100" />
        </div>
        {agent.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{agent.description}</p>
        ) : null}
        {tags.length ? (
          <div className="mt-auto flex flex-wrap gap-1 pt-1">
            {tags.slice(0, 3).map((t) => (
              <Badge key={t} variant="outline" className="h-5 rounded-md text-[11px] font-normal">
                {t}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    </Link>
  )
}
