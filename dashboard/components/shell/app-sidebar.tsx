"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { motion } from "motion/react"
import {
  BookOpenTextIcon,
  Building2Icon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LayersIcon,
  LogOutIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  TimerIcon,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
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
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Expand } from "@/components/motion"
import { LogoMark } from "@/components/logo"
import { ThemeSegmented } from "@/components/theme-toggle"
import { useApi } from "@/hooks/use-api"
import type { UsageList } from "@/lib/api"
import { compactNumber } from "@/lib/format"
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

/** Whether the desktop sidebar is collapsed to icons. */
function useIconMode() {
  const { state, isMobile } = useSidebar()
  return state === "collapsed" && !isMobile
}

/** Brand row with the collapse toggle; collapsed, only the toggle remains. */
function Brand() {
  const { toggleSidebar } = useSidebar()
  const iconMode = useIconMode()
  return (
    <div className="flex h-10 items-center gap-2 px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
      {!iconMode ? (
        <Link href="/" className="flex min-w-0 flex-1 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
          <LogoMark className="size-6 rounded-md [&_svg]:size-3.5" />
          <span className="truncate font-heading text-[15px] font-semibold tracking-tight">Runhive</span>
        </Link>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleSidebar}
              aria-label={iconMode ? "Expand sidebar" : "Collapse sidebar"}
              className="text-sidebar-foreground/70 hover:text-sidebar-foreground"
            />
          }
        >
          <PanelLeftIcon />
        </TooltipTrigger>
        <TooltipContent side="right">
          {iconMode ? "Expand" : "Collapse"} <Kbd>Ctrl B</Kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/** Compact project picker, like the Console's workspace switcher. */
function ProjectSwitcher() {
  const project = useProject()
  const iconMode = useIconMode()
  const [copied, setCopied] = React.useState(false)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          iconMode ? (
            <SidebarMenuButton tooltip={project.name} className="justify-center group-data-[collapsible=icon]:p-1!" />
          ) : (
            <SidebarMenuButton
              variant="outline"
              className="h-9 bg-sidebar shadow-[0_0_0_1px_var(--sidebar-border)] data-popup-open:bg-sidebar-accent"
            />
          )
        }
      >
        {iconMode ? (
          <span className="flex size-6! shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-[11px] font-semibold text-sidebar-primary-foreground">
            {initials(project.name).slice(0, 1)}
          </span>
        ) : (
          <>
            <span className="size-3.5 shrink-0 rounded-[4px] bg-sidebar-primary" />
            <span className="truncate font-medium">{project.name}</span>
            <ChevronDownIcon className="ml-auto size-4 text-sidebar-foreground/60 transition-transform duration-300 ease-(--ease-out-quint) group-data-popup-open/menu-button:rotate-180" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-(--anchor-width) min-w-64" align="start" side={iconMode ? "right" : "bottom"} sideOffset={6}>
        <DropdownMenuGroup>
          <DropdownMenuItem disabled className="items-start gap-2.5 py-1.5">
            <Building2Icon className="mt-0.5" />
            <div className="grid leading-tight">
              <span>All projects</span>
              <span className="text-xs text-muted-foreground">Each API key belongs to one project</span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem className="gap-2.5 py-1.5">
            <span className="size-3.5 shrink-0 rounded-[4px] bg-sidebar-primary" />
            <span className="flex-1 truncate">{project.name}</span>
            <CheckIcon className="text-info" />
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link href="/api-keys?new=1" />}>
            <PlusIcon />
            Create API key
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
          <DropdownMenuItem render={<Link href="/settings" />}>
            <LayersIcon />
            Manage project
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void signOut()}>
            <KeyRoundIcon />
            Switch API key
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A nav link; the active one carries a pill that glides between items. */
function NavLink({ item, pathname, nested = false }: { item: NavItem; pathname: string; nested?: boolean }) {
  const active = isActive(item.href, pathname)
  const { isMobile, setOpenMobile } = useSidebar()
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={item.title}
        className={cn("isolate data-active:bg-transparent", nested && "h-7.5 text-sidebar-foreground/80 data-active:text-sidebar-foreground")}
        render={<Link href={item.href} onClick={() => isMobile && setOpenMobile(false)} />}
      >
        {active ? (
          <motion.span
            layoutId="sidebar-active"
            className="absolute inset-0 -z-10 rounded-md bg-sidebar-accent"
            transition={{ type: "spring", bounce: 0.15, duration: 0.45 }}
          />
        ) : null}
        {nested ? null : <item.icon />}
        <span>{item.title}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/** Collapsed: the group's icon opens a flyout with its pages. */
function GroupFlyout({ group, pathname }: { group: NavGroup; pathname: string }) {
  const active = group.items.some((i) => isActive(i.href, pathname))
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton
              isActive={active}
              tooltip={group.title}
              className="data-popup-open:bg-sidebar-accent"
            />
          }
        >
          <group.icon />
          <span>{group.title}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" sideOffset={10} className="min-w-48">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">{group.title}</DropdownMenuLabel>
            {group.items.map((item) => (
              <DropdownMenuItem key={item.href} render={<Link href={item.href} />}>
                <item.icon />
                <span className="flex-1">{item.title}</span>
                {isActive(item.href, pathname) ? <CheckIcon className="text-muted-foreground" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

/** Expanded: a row with a right chevron that unfolds its pages. */
function NavSection({ group, pathname }: { group: NavGroup; pathname: string }) {
  const iconMode = useIconMode()
  const containsActive = group.items.some((i) => isActive(i.href, pathname))
  // Sections start open around the current page, like the Console; the user's toggle wins after that.
  const [toggled, setToggled] = React.useState<boolean | null>(null)
  const open = toggled ?? containsActive
  if (iconMode) return <GroupFlyout group={group} pathname={pathname} />
  return (
    <SidebarMenuItem>
      <SidebarMenuButton onClick={() => setToggled(!open)} aria-expanded={open}>
        <group.icon />
        <span>{group.title}</span>
        <ChevronRightIcon
          className={cn(
            "ml-auto size-4! text-sidebar-foreground/60 transition-transform duration-300 ease-(--ease-out-quint)",
            open && "rotate-90"
          )}
        />
      </SidebarMenuButton>
      <Expand open={open}>
        <SidebarMenu className="relative mt-0.5 mb-1 ml-[1.1rem] gap-0.5 border-l border-sidebar-border pl-2.5">
          {group.items.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} nested />
          ))}
        </SidebarMenu>
      </Expand>
    </SidebarMenuItem>
  )
}

/** Tokens used in the last 30 days, shown where the Console shows credits. */
function UsageLink() {
  const usage = useApi<UsageList>("/v1/usage", { days: 30 })
  const total = (usage.data?.usage ?? []).reduce((a, r) => a + r.input_tokens + r.output_tokens, 0)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton tooltip="Usage, last 30 days" render={<Link href="/usage" />}>
        <TimerIcon />
        <span>Usage</span>
      </SidebarMenuButton>
      {usage.data ? (
        <SidebarMenuBadge className="font-normal text-sidebar-foreground/60">{compactNumber(total)} tokens</SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  )
}

function AccountMenu() {
  const project = useProject()
  const iconMode = useIconMode()
  const label = `${project.role.charAt(0).toUpperCase()}${project.role.slice(1)} key`
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<SidebarMenuButton size="lg" tooltip={label} className="data-popup-open:bg-sidebar-accent" />}
      >
        {iconMode ? (
          <span className="flex size-8! shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold ring-1 ring-sidebar-border">
            {initials(project.name)}
          </span>
        ) : (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent ring-1 ring-sidebar-border">
            <Building2Icon className="size-4!" />
          </span>
        )}
        <div className="grid flex-1 text-left leading-tight">
          <span className="truncate text-sm font-medium">{label}</span>
          <span className="truncate text-xs text-sidebar-foreground/60">{project.name}</span>
        </div>
        <ChevronDownIcon className="ml-auto size-4 text-sidebar-foreground/60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side={iconMode ? "right" : "top"} align={iconMode ? "end" : "start"} sideOffset={6} className="w-(--anchor-width) min-w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="grid gap-0.5 font-normal">
            <span className="text-sm font-medium text-foreground">{label}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">{project.server}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="flex items-center justify-between gap-3 px-1.5 py-1">
          <span className="text-sm">Theme</span>
          <ThemeSegmented />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/settings" />}>
          <SettingsIcon />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link href="/api-keys" />}>
          <KeyRoundIcon />
          API keys
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
      <SidebarHeader className="gap-2 pt-3">
        <Brand />
        <SidebarMenu className="gap-1.5">
          <SidebarMenuItem>
            <ProjectSwitcher />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Search"
              onClick={onSearch}
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
        <SidebarGroup className="pt-1">
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
      <SidebarSeparator className="mx-0" />
      <SidebarFooter className="gap-1 pb-3">
        <SidebarMenu className="gap-0.5">
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Documentation" render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />}>
              <BookOpenTextIcon />
              <span>Documentation</span>
              <ExternalLinkIcon className="ml-auto size-3! opacity-50" />
            </SidebarMenuButton>
          </SidebarMenuItem>
          <UsageLink />
          <SidebarMenuItem className="mt-1">
            <AccountMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
