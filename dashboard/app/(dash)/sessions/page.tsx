import type { Metadata } from "next";
import { SessionsView } from "./sessions-view";

export const metadata: Metadata = { title: "Sessions" };

export default async function SessionsPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const { agent } = await searchParams;
  return <SessionsView initialAgent={agent ?? ""} />;
}
