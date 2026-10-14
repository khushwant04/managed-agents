import * as React from "react"
import Link from "next/link"
import { ChevronLeftIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { FadeIn } from "@/components/motion"

/** Content column for a console page. */
export function Page({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-8 md:py-8",
        className
      )}
      {...props}
    />
  )
}

/** Title row: heading, optional description and actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  eyebrow?: React.ReactNode
  className?: string
}) {
  return (
    <FadeIn
      y={4}
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between",
        className
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow ? (
          <div className="text-xs font-medium text-muted-foreground">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="truncate font-heading text-2xl font-semibold tracking-tight text-balance">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </FadeIn>
  )
}

/** A titled block inside a page. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      {title || actions ? (
        <div className="flex items-end justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            {title ? (
              <h2 className="text-sm font-semibold">{title}</h2>
            ) : null}
            {description ? (
              <p className="text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/** Small link back to the parent list, shown above a detail page's title. */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group/back -mb-2 inline-flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <ChevronLeftIcon className="size-4 transition-transform duration-200 ease-(--ease-out-quint) group-hover/back:-translate-x-0.5" />
      {children}
    </Link>
  )
}
