"use client"

import Link from "next/link"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { LogoMark } from "@/components/logo"

/** Phones only: the bar that opens the sidebar sheet. Desktop has no header. */
export function MobileHeader() {
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-md supports-backdrop-filter:bg-background/65 md:hidden">
      <SidebarTrigger className="-ml-0.5" />
      <Link href="/" className="flex items-center gap-2 font-heading text-[15px] font-semibold tracking-tight">
        <LogoMark className="size-6 rounded-md [&_svg]:size-3.5" />
        Managed Agents
      </Link>
    </header>
  )
}
