import { Suspense } from "react"
import type { Metadata } from "next"
import { PlaygroundView } from "./playground-view"

export const metadata: Metadata = { title: "Playground" }

export default function PlaygroundPage() {
  return (
    <Suspense>
      <PlaygroundView />
    </Suspense>
  )
}
