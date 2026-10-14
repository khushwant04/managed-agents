import { Suspense } from "react"
import type { Metadata } from "next"
import { SecretsView } from "./secrets-view"

export const metadata: Metadata = { title: "Secrets" }

export default function SecretsPage() {
  return (
    <Suspense>
      <SecretsView />
    </Suspense>
  )
}
