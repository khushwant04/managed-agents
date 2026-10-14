import { Suspense } from "react"
import type { Metadata } from "next"
import { DeploymentsView } from "./deployments-view"

export const metadata: Metadata = { title: "Deployments" }

export default function DeploymentsPage() {
  return (
    <Suspense>
      <DeploymentsView />
    </Suspense>
  )
}
