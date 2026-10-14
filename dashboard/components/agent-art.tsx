import { cn } from "@/lib/utils"

/** Stable 32-bit hash of a string. */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Generative artwork for an agent, like the model cards in the vendor consoles:
 * two soft blobs and a ring in hues derived from the agent's name.
 */
export function AgentArt({ name, className }: { name: string; className?: string }) {
  const h = hash(name)
  const hue = h % 360
  const hue2 = (hue + 40 + ((h >> 9) % 80)) % 360
  const x = 20 + ((h >> 3) % 60)
  const y = 20 + ((h >> 11) % 50)
  return (
    <div
      aria-hidden
      className={cn("relative isolate overflow-hidden", className)}
      style={{
        background: `radial-gradient(circle at ${x}% ${y}%, oklch(0.78 0.14 ${hue}) 0%, transparent 55%), radial-gradient(circle at ${100 - x}% ${100 - y / 2}%, oklch(0.7 0.16 ${hue2}) 0%, transparent 60%), oklch(0.93 0.04 ${hue})`,
      }}
    >
      <div
        className="absolute rounded-full border-[10px] border-white/35 mix-blend-overlay transition-transform duration-700 ease-(--ease-out-quint) group-hover/agent:scale-110 group-hover/agent:rotate-12"
        style={{ width: "70%", aspectRatio: "1", left: `${x - 10}%`, top: `${y - 25}%` }}
      />
      <div className="absolute inset-0 bg-linear-to-b from-transparent to-black/10 dark:to-black/40" />
    </div>
  )
}
