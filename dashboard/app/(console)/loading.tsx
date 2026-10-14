import { Page } from "@/components/page"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <Page>
      <Skeleton className="h-8 w-56" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-72" />
    </Page>
  )
}
