"use client"

import * as React from "react"
import { ArrowUpRightIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Stagger, StaggerItem } from "@/components/motion"
import type { Template } from "./templates"

/** "Start with a template" cards, after the Workbench's prompt library. */
export function TemplateGrid({ templates, onPick }: { templates: Template[]; onPick: (t: Template) => void }) {
  return (
    <Stagger className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" gap={0.05} delay={0.1}>
      {templates.map((t) => (
        <StaggerItem key={t.id} className="flex">
          <button
            type="button"
            onClick={() => onPick(t)}
            className="group/tpl flex flex-1 flex-col gap-3 rounded-xl bg-card p-4 text-left shadow-card ring-1 ring-foreground/10 transition-[box-shadow,transform] duration-300 ease-(--ease-out-quint) outline-none hover:-translate-y-0.5 hover:shadow-card-hover focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex items-start justify-between">
              <div className="flex size-9 items-center justify-center rounded-lg bg-muted transition-colors duration-300 group-hover/tpl:bg-primary group-hover/tpl:text-primary-foreground">
                <t.icon className="size-4" />
              </div>
              <ArrowUpRightIcon className="size-4 text-muted-foreground opacity-0 transition-all duration-300 group-hover/tpl:translate-x-0.5 group-hover/tpl:-translate-y-0.5 group-hover/tpl:opacity-100" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t.title}</span>
              <span className="line-clamp-2 text-xs text-muted-foreground">{t.description}</span>
            </div>
            <div className="mt-auto flex flex-wrap gap-1">
              {t.features.map((f) => (
                <Badge key={f} variant="muted" className="h-5 rounded-md text-[11px] font-normal">
                  {f}
                </Badge>
              ))}
            </div>
          </button>
        </StaggerItem>
      ))}
    </Stagger>
  )
}
