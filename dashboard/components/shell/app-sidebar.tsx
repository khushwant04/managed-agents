"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { motion } from "motion/react"
import {
  BookOpenTextIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  LogOutIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import { Expand } from "@/components/motion"
import { ThemeSegmented } from "@/components/theme-toggle"
import { DOCS_URL, NAV, isActive, isGroup, type NavGroup, type NavItem } from "./nav"
import { signOut, useProject } from "./project-context"
import { cn } from "@/lib/utils"

function initials(name: string): string {
  return (
    name
      .split(/[\s_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "MA"
  )
}

/** A nav link; the active one carries a pill that glides between items. */
function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(item.href, pathname)
  const { isMobile, setOpenMobile } = useSidebar()
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={item.title}
        className="isolate data-active:bg-transparent"
        render={<Link href={item.href} onClick={() => isMobile && setOpenMobile(false)} />}
      >
        {active ? (
          <motion.span
            layoutId="sidebar-active"
            className="absolute inset-0 -z-10 rounded-md bg-sidebar-accent shadow-[0_0_0_1px_var(--sidebar-border)]"
            transition={{ type: "spring", bounce: 0.15, duration: 0.45 }}
          />
        ) : null}
        <item.icon />
        <span>{item.title}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function NavSection({ group, pathname }: { group: NavGroup; pathname: string }) {
  const { state, isMobile } = useSidebar()
  const containsActive = group.items.some((i) => isActive(i.href, pathname))
  const [open, setOpen] = React.useState(true)
  // When collapsed to icons the group header disappears and its items show directly.
  if (state === "collapsed" && !isMobile) {
    return group.items.map((item) => <NavLink key={item.href} item={item} pathname={pathname} />)
  }
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn("text-sidebar-foreground/70", containsActive && !open && "text-sidebar-foreground")}
      >
        <group.icon />
        <span>{group.title}</span>
        <ChevronRightIcon
          className={cn(
            "ml-auto size-3.5! transition-transform duration-300 ease-(--ease-out-quint)",
            open && "rotate-90"
          )}
        />
      </SidebarMenuButton>
      <Expand open={open}>
        <SidebarMenu className="relative mt-0.5 ml-3.5 border-l border-sidebar-border pl-2">
          {group.items.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
        </SidebarMenu>
      </Expand>
    </SidebarMenuItem>
  )
}

function ProjectSwitcher() {
  const project = useProject()
  const [copied, setCopied] = React.useState(false)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            size="lg"
            className="data-popup-open:bg-sidebar-accent"
          />
        }
      >
        <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground shadow-button">
          {initials(project.name)}
        </div>
        <div className="grid flex-1 text-left leading-tight">
          <span className="truncate text-sm font-medium">{project.name}</span>
          <span className="truncate text-xs text-sidebar-foreground/60 capitalize">
            {project.role}
          </span>
        </div>
        <ChevronsUpDownIcon className="ml-auto size-4 text-sidebar-foreground/50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-(--anchor-width) min-w-60" align="start" sideOffset={6}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs text-muted-foreground">Project</DropdownMenuLabel>
          <DropdownMenuItem className="gap-2">
            <div className="flex size-6 items-center justify-center rounded-md bg-primary text-[10px] font-semibold text-primary-foreground">
              {initials(project.name)}
            </div>
            <div className="grid flex-1 leading-tight">
              <span className="truncate">{project.name}</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {project.id || "—"}
              </span>
            </div>
            <CheckIcon className="size-4" />
          </DropdownMenuItem>
          {project.id ? (
            <DropdownMenuItem
              closeOnClick={false}
              onClick={() => {
                void navigator.clipboard?.writeText(project.id).then(() => setCopied(true))
                setTimeout(() => setCopied(false), 1200)
              }}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "Copied" : "Copy project ID"}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ServerIcon className="size-3" />
            <span className="truncate font-mono">{project.server}</span>
          </DropdownMenuLabel>
          <DropdownMenuItem render={<Link href="/settings" />}>
            <SettingsIcon />
            Project settings
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => void signOut()}>
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function UserFooter() {
  const project = useProject()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-medium ring-1 ring-sidebar-border">
          {initials(project.role)}
        </div>
        <div className="grid flex-1 text-left leading-tight">
          <span className="truncate text-sm font-medium capitalize">{project.role} key</span>
          <span className="truncate text-xs text-sidebar-foreground/60">{project.name}</span>
        </div>
        <ChevronsUpDownIcon className="ml-auto size-4 text-sidebar-foreground/50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-(--anchor-width) min-w-60">
        <div className="flex items-center justify-between gap-3 px-2 py-1.5">
          <span className="text-sm">Theme</span>
          <ThemeSegmented />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/settings" />}>
          <SettingsIcon />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />}>
          <BookOpenTextIcon />
          Documentation
          <ExternalLinkIcon className="ml-auto size-3.5 text-muted-foreground" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => void signOut()}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppSidebar({ onSearch }: { onSearch: () => void }) {
  const pathname = usePathname()
  return (
    <Sidebar variant="sidebar" collapsible="icon">
      <SidebarHeader className="gap-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <ProjectSwitcher />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Search"
              onClick={onSearch}
              variant="outline"
              className="text-sidebar-foreground/60 hover:text-sidebar-foreground"
            >
              <SearchIcon />
              <span>Search</span>
              <Kbd className="ml-auto group-data-[collapsible=icon]:hidden">Ctrl K</Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {NAV.map((entry) =>
                isGroup(entry) ? (
                  <NavSection key={entry.title} group={entry} pathname={pathname} />
                ) : (
                  <NavLink key={entry.href} item={entry} pathname={pathname} />
                )
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Documentation"
              render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />}
            >
              <BookOpenTextIcon />
              <span>Documentation</span>
              <ExternalLinkIcon className="ml-auto size-3! opacity-50" />
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <UserFooter />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
