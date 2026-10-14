"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { AnimatePresence, motion } from "motion/react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { ChevronRightIcon } from "lucide-react"
import {
  Breadcrumb,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb"
import { ThemeSegmented } from "@/components/theme-toggle"
import { NAV, isGroup, isActive } from "./nav"

interface Crumb {
  label: string
  href?: string
}

/** Breadcrumbs from the nav tree plus any dynamic tail (an agent, a session). */
function crumbsFor(pathname: string): Crumb[] {
  for (const entry of NAV) {
    const items = isGroup(entry) ? entry.items : [entry]
    for (const item of items) {
      if (!isActive(item.href, pathname)) continue
      const out: Crumb[] = []
      if (isGroup(entry)) out.push({ label: entry.title })
      out.push({ label: item.title, href: item.href })
      const rest = pathname.slice(item.href.length).split("/").filter(Boolean)
      for (const seg of rest) out.push({ label: decodeURIComponent(seg) })
      return out
    }
  }
  return [{ label: "Dashboard", href: "/" }]
}

export function SiteHeader() {
  const pathname = usePathname()
  const crumbs = crumbsFor(pathname)
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-md supports-backdrop-filter:bg-background/65 md:rounded-t-xl">
      <SidebarTrigger className="-ml-0.5" />
      <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-center" />
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap">
          <AnimatePresence mode="popLayout" initial={false}>
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1
              return (
                <motion.li
                  key={`${i}-${c.label}`}
                  layout
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  {i > 0 ? <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 opacity-60" /> : null}
                  {last || !c.href ? (
                    <BreadcrumbPage className={last ? "truncate font-medium" : "truncate text-muted-foreground"}>
                      {c.label}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink className="truncate" render={<Link href={c.href} />}>
                      {c.label}
                    </BreadcrumbLink>
                  )}
                </motion.li>
              )
            })}
          </AnimatePresence>
        </BreadcrumbList>
      </Breadcrumb>
      <ThemeSegmented className="hidden sm:inline-flex" />
    </header>
  )
}
