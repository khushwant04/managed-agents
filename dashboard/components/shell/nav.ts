import {
  ActivityIcon,
  BookOpenIcon,
  BotIcon,
  BoxIcon,
  ChartColumnIcon,
  FlaskConicalIcon,
  KeyRoundIcon,
  HammerIcon,
  HouseIcon,
  ChartLineIcon,
  LockKeyholeIcon,
  type LucideIcon,
  RocketIcon,
  ScrollTextIcon,
  SettingsIcon,
  WebhookIcon,
} from "lucide-react"

export interface NavItem {
  title: string
  href: string
  icon: LucideIcon
  /** Extra words the command menu matches on. */
  keywords?: string[]
}

export interface NavGroup {
  title: string
  icon: LucideIcon
  items: NavItem[]
}

export type NavEntry = NavItem | NavGroup

export const isGroup = (e: NavEntry): e is NavGroup => "items" in e

/** The console's navigation, shared by the sidebar and the command menu. */
export const NAV: NavEntry[] = [
  { title: "Dashboard", href: "/", icon: HouseIcon, keywords: ["home", "overview"] },
  { title: "API keys", href: "/api-keys", icon: KeyRoundIcon, keywords: ["keys", "token", "auth"] },
  {
    title: "Build",
    icon: HammerIcon,
    items: [
      { title: "Playground", href: "/playground", icon: FlaskConicalIcon, keywords: ["run", "invoke", "try"] },
      { title: "Agents", href: "/agents", icon: BotIcon, keywords: ["versions", "aliases", "register"] },
      { title: "Skills", href: "/skills", icon: BookOpenIcon, keywords: ["bundles"] },
      { title: "Environments", href: "/environments", icon: BoxIcon, keywords: ["sandbox", "e2b", "template"] },
    ],
  },
  {
    title: "Deploy",
    icon: RocketIcon,
    items: [
      { title: "Deployments", href: "/deployments", icon: RocketIcon, keywords: ["triggers", "cron", "queue"] },
      { title: "Webhooks", href: "/webhooks", icon: WebhookIcon, keywords: ["github", "slack", "stripe", "hooks"] },
      { title: "Secrets", href: "/secrets", icon: LockKeyholeIcon, keywords: ["credentials", "env"] },
    ],
  },
  { title: "Sessions", href: "/sessions", icon: ActivityIcon, keywords: ["runs", "timeline", "replay", "events"] },
  {
    title: "Analytics",
    icon: ChartLineIcon,
    items: [
      { title: "Usage", href: "/usage", icon: ChartColumnIcon, keywords: ["tokens", "cost", "caching"] },
      { title: "Logs", href: "/logs", icon: ScrollTextIcon, keywords: ["audit", "activity"] },
    ],
  },
  { title: "Settings", href: "/settings", icon: SettingsIcon, keywords: ["project", "policy", "appearance", "theme"] },
]

export const DOCS_URL = "https://github.com/khushwant04/managed-agents/tree/main/docs"

export function flatNav(): NavItem[] {
  return NAV.flatMap((e) => (isGroup(e) ? e.items : [e]))
}

/** Whether `href` is the current section for `pathname`. */
export function isActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`)
}
