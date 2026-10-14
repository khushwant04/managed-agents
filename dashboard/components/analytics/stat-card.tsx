"use client"

import * as React from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { AnimatedNumber } from "@/components/motion"
import { cn } from "@/lib/utils"

/** A Console-style KPI tile: label, a counting-up number and an optional footer. */
export function StatCard({
  title,
  icon: Icon,
  value,
  format,
  loading,
  className,
  size = "default",
  children,
}: {
  title: string
  icon?: React.ElementType
  value: number | undefined
  format?: (n: number) => string
  loading?: boolean
  className?: string
  size?: "default" | "lg"
  children?: React.ReactNode
}) {
  return (
    <Card className={cn("h-full gap-3", className)}>
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5">
          {Icon ? <Icon className="size-3.5" /> : null}
          {title}
        </CardDescription>
        <CardTitle
          className={cn(
            "font-semibold tracking-tight tabular-nums",
            size === "lg" ? "text-4xl" : "text-2xl"
          )}
        >
          {loading || value === undefined ? (
            <Skeleton className={size === "lg" ? "h-10 w-36" : "h-8 w-20"} />
          ) : (
            <AnimatedNumber value={value} format={format} />
          )}
        </CardTitle>
      </CardHeader>
      {children ? (
        <CardContent className="mt-auto flex flex-col gap-2 text-xs text-muted-foreground">
          {children}
        </CardContent>
      ) : null}
    </Card>
  )
}
