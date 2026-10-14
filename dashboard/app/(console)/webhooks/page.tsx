import { Suspense } from "react"
import type { Metadata } from "next"
import { WebhooksView } from "./webhooks-view"

export const metadata: Metadata = { title: "Webhooks" }

export default function WebhooksPage() {
  return (
    <Suspense>
      <WebhooksView />
    </Suspense>
  )
}
