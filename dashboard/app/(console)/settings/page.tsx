import type { Metadata } from "next"
import { SettingsView, type SettingsTab } from "./settings-view"

export const metadata: Metadata = { title: "Settings" }

const TABS: SettingsTab[] = ["general", "appearance", "policy", "session"]

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams
  const initial = TABS.find((t) => t === tab) ?? "general"
  return <SettingsView initialTab={initial} />
}
