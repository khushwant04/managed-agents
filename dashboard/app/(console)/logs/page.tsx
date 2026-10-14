import type { Metadata } from "next"
import { LogsView } from "./logs-view"

export const metadata: Metadata = { title: "Logs" }

export default function LogsPage() {
  return <LogsView />
}
