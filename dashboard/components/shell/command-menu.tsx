"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import {
  BotIcon,
  FlaskConicalIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SunIcon,
} from "lucide-react"
import {
  CommandDialog,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { useApi } from "@/hooks/use-api"
import type { AgentList } from "@/lib/api"
import { flatNav } from "./nav"
import { signOut } from "./project-context"

/** Ctrl/⌘ K palette: pages, agents and quick actions. */
export function CommandMenu({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { setTheme } = useTheme()
  // Agents load the first time the palette opens and stay cached.
  const [wanted, setWanted] = React.useState(false)
  if (open && !wanted) setWanted(true)
  const agents = useApi<AgentList>(wanted ? "/v1/agents" : null)

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onOpenChange])

  const go = (fn: () => void) => {
    onOpenChange(false)
    fn()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Jump to a page, an agent or an action"
      className="sm:max-w-lg"
    >
      <Command loop>
        <CommandInput placeholder="Search pages, agents and actions…" />
        <CommandList className="max-h-[min(24rem,60vh)]">
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Pages">
            {flatNav().map((item) => (
              <CommandItem
                key={item.href}
                value={`${item.title} ${item.keywords?.join(" ") ?? ""}`}
                onSelect={() => go(() => router.push(item.href))}
              >
                <item.icon />
                {item.title}
              </CommandItem>
            ))}
          </CommandGroup>
          {agents.data?.agents.length ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Agents">
                {agents.data.agents.slice(0, 30).map((a) => (
                  <CommandItem
                    key={a.name}
                    value={`agent ${a.name} ${a.description ?? ""}`}
                    onSelect={() => go(() => router.push(`/agents/${encodeURIComponent(a.name)}`))}
                  >
                    <BotIcon />
                    <span className="truncate">{a.name}</span>
                    <CommandShortcut>v{a.latest_version}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          ) : null}
          <CommandSeparator />
          <CommandGroup heading="Actions">
            <CommandItem value="register new agent create" onSelect={() => go(() => router.push("/agents?new=1"))}>
              <PlusIcon />
              Register an agent
            </CommandItem>
            <CommandItem value="open playground run invoke" onSelect={() => go(() => router.push("/playground"))}>
              <FlaskConicalIcon />
              Open the playground
            </CommandItem>
            <CommandItem value="new deployment create" onSelect={() => go(() => router.push("/deployments?new=1"))}>
              <PlusIcon />
              Create a deployment
            </CommandItem>
            <CommandItem value="theme light" onSelect={() => go(() => setTheme("light"))}>
              <SunIcon />
              Light theme
            </CommandItem>
            <CommandItem value="theme dark" onSelect={() => go(() => setTheme("dark"))}>
              <MoonIcon />
              Dark theme
            </CommandItem>
            <CommandItem value="theme system" onSelect={() => go(() => setTheme("system"))}>
              <MonitorIcon />
              System theme
            </CommandItem>
            <CommandItem value="sign out log out" onSelect={() => go(() => void signOut())}>
              <LogOutIcon />
              Sign out
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
