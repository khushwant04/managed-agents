import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <div className="relative grid min-h-svh place-items-center overflow-hidden p-6">
      <div className="bg-grid absolute inset-0" aria-hidden />
      <div className="relative flex flex-col items-center gap-3 text-center">
        <p className="font-mono text-sm text-muted-foreground">404</p>
        <h1 className="text-2xl font-semibold tracking-tight">This page doesn&apos;t exist</h1>
        <p className="max-w-sm text-sm text-muted-foreground">The link may be old, or the agent, deployment or session was removed.</p>
        <Button render={<Link href="/" />} className="mt-2">Back to the dashboard</Button>
      </div>
    </div>
  )
}
