import { Suspense } from "react"
import type { Metadata } from "next"
import { AgentsView } from "./agents-view"

export const metadata: Metadata = { title: "Agents" }

export default function AgentsPage() {
  return (
    <Suspense>
      <AgentsView />
    </Suspense>
  )
}
