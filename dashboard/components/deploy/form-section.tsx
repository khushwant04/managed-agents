import * as React from "react"
import { cn } from "@/lib/utils"

/** A titled group of fields inside a long dialog form. */
export function FormSection({
  title,
  description,
  aside,
  children,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium">{title}</h3>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** Scrollable body for tall dialogs; the header and footer stay put. */
export function DialogScrollBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("-mx-4 max-h-[min(68vh,46rem)] overflow-y-auto overscroll-contain border-y px-4 py-4", className)}
      {...props}
    />
  )
}
