import { Suspense } from "react"
import type { Metadata } from "next"
import { EnvironmentsView } from "./environments-view"

export const metadata: Metadata = { title: "Environments" }

export default function EnvironmentsPage() {
  return (
    <Suspense>
      <EnvironmentsView />
    </Suspense>
  )
}
