import { EyeIcon, ShieldIcon, TerminalSquareIcon, type LucideIcon } from "lucide-react"

export type Role = "viewer" | "developer" | "admin"

/** API key roles, lowest to highest. */
export const ROLES: { value: Role; label: string; description: string; icon: LucideIcon }[] = [
  { value: "viewer", label: "Viewer", description: "Read agents, deployments, sessions and usage.", icon: EyeIcon },
  { value: "developer", label: "Developer", description: "Also register agents, deploy, invoke and steer sessions.", icon: TerminalSquareIcon },
  { value: "admin", label: "Admin", description: "Everything, plus secrets, API keys, policy and the audit log.", icon: ShieldIcon },
]

export const roleMeta = (role: string | null | undefined) => ROLES.find((r) => r.value === role)
