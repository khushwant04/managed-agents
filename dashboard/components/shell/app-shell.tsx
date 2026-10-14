"use client"

import * as React from "react"
import { MotionConfig } from "motion/react"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "./app-sidebar"
import { CommandMenu } from "./command-menu"
import { SiteHeader } from "./site-header"
import { ProjectProvider, type ProjectInfo } from "./project-context"

/** Signed-in console chrome: sidebar, sticky header, command menu. */
export function AppShell({
  project,
  defaultOpen,
  children,
}: {
  project: ProjectInfo
  defaultOpen: boolean
  children: React.ReactNode
}) {
  const [searchOpen, setSearchOpen] = React.useState(false)
  return (
    <ProjectProvider project={project}>
      <MotionConfig reducedMotion="user">
        <a
          href="#main"
          className="fixed top-2 left-2 z-50 -translate-y-16 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground shadow-elevated transition-transform focus:translate-y-0"
        >
          Skip to content
        </a>
        <SidebarProvider defaultOpen={defaultOpen}>
          <AppSidebar onSearch={() => setSearchOpen(true)} />
          <SidebarInset className="min-w-0">
            <SiteHeader />
            <div id="main" tabIndex={-1} className="flex flex-1 flex-col outline-none">
              {children}
            </div>
          </SidebarInset>
          <CommandMenu open={searchOpen} onOpenChange={setSearchOpen} />
        </SidebarProvider>
      </MotionConfig>
    </ProjectProvider>
  )
}
