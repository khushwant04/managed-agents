"use client"

import * as React from "react"
import { AlertCircleIcon, RotateCwIcon } from "lucide-react"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { FadeIn } from "@/components/motion"
import { cn } from "@/lib/utils"

/** Inline error with a retry. */
export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: Error | string
  onRetry?: () => void
  className?: string
}) {
  return (
    <FadeIn
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-xl bg-destructive/6 p-4 text-sm ring-1 ring-destructive/20",
        className
      )}
    >
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-medium text-destructive">Something went wrong</p>
        <p className="break-words text-muted-foreground">
          {typeof error === "string" ? error : error.message}
        </p>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCwIcon data-icon="inline-start" />
          Retry
        </Button>
      ) : null}
    </FadeIn>
  )
}

/** Empty state in the Console style: grid backdrop, icon tile, copy, action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <FadeIn>
      <Empty
        className={cn(
          "relative isolate overflow-hidden rounded-xl border border-dashed py-16",
          className
        )}
      >
        <div className="bg-grid absolute inset-0 -z-10" aria-hidden />
        <EmptyHeader>
          {icon ? (
            <EmptyMedia
              variant="icon"
              className="size-10 rounded-xl bg-background shadow-card ring-1 ring-foreground/10"
            >
              {icon}
            </EmptyMedia>
          ) : null}
          <EmptyTitle>{title}</EmptyTitle>
          {description ? (
            <EmptyDescription>{description}</EmptyDescription>
          ) : null}
        </EmptyHeader>
        {action ? <EmptyContent>{action}</EmptyContent> : null}
      </Empty>
    </FadeIn>
  )
}

/** Placeholder rows while a table loads. */
export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="flex flex-col gap-2 p-1">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton
              key={c}
              className="h-5"
              style={{ width: `${c === 0 ? 28 : 100 / cols - 4}%`, animationDelay: `${r * 80}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
