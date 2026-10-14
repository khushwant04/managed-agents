/** Deployment triggers: typed views over the API's loose trigger objects, drafts for forms, webhook endpoints. */
import type { Deployment } from "./api";
import { cronError } from "./cron";

export type TriggerType = "http" | "webhook" | "cron" | "queue";
export type WebhookProvider = "github" | "slack" | "stripe" | "generic";

export const TRIGGER_TYPES: TriggerType[] = ["http", "webhook", "cron", "queue"];
export const PROVIDERS: WebhookProvider[] = ["github", "slack", "stripe", "generic"];

export type Trigger =
  | { type: "http" }
  | { type: "webhook"; provider: WebhookProvider; input?: string }
  | { type: "cron"; schedule: string; input: string; timezone?: string }
  | { type: "queue"; name: string };

export const TRIGGER_LABEL: Record<TriggerType, string> = {
  http: "HTTP",
  webhook: "Webhook",
  cron: "Cron",
  queue: "Queue",
};

export const PROVIDER_LABEL: Record<WebhookProvider, string> = {
  github: "GitHub",
  slack: "Slack",
  stripe: "Stripe",
  generic: "Generic",
};

/** How each provider signs deliveries (mirrors agents_server.triggers.verify_webhook). */
export const PROVIDER_SIGNING: Record<WebhookProvider, { header: string; scheme: string; event: string; setup: string }> = {
  github: {
    header: "X-Hub-Signature-256",
    scheme: "sha256=HMAC-SHA256(secret, body)",
    event: "X-GitHub-Event + payload.action, e.g. pull_request.opened",
    setup: "Repository → Settings → Webhooks → Add webhook. Paste the URL, set the content type to application/json and use the signing secret as the webhook secret.",
  },
  slack: {
    header: "X-Slack-Signature, X-Slack-Request-Timestamp",
    scheme: "v0=HMAC-SHA256(secret, \"v0:{timestamp}:{body}\")",
    event: "payload.event.type, e.g. app_mention",
    setup: "Your Slack app → Event Subscriptions. Paste the URL as the request URL (the url_verification challenge is answered for you) and use the app's signing secret here.",
  },
  stripe: {
    header: "Stripe-Signature",
    scheme: "t={timestamp},v1=HMAC-SHA256(secret, \"{timestamp}.{body}\")",
    event: "payload.type, e.g. invoice.payment_failed",
    setup: "Dashboard → Developers → Webhooks → Add endpoint. Paste the URL, then copy the endpoint's signing secret (whsec_…) into this deployment.",
  },
  generic: {
    header: "X-Agents-Signature (event name in X-Agents-Event)",
    scheme: "t={timestamp},v1=HMAC-SHA256(secret, \"{timestamp}.{body}\")",
    event: "X-Agents-Event header, else \"event\"",
    setup: "Sign each request yourself with the scheme below. Timestamps older than five minutes are rejected.",
  },
};

export function isProvider(v: unknown): v is WebhookProvider {
  return typeof v === "string" && (PROVIDERS as string[]).includes(v);
}

/** Read an API trigger object as a typed trigger (unknown types are kept as http-like). */
export function parseTrigger(raw: Record<string, unknown>): Trigger {
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  switch (raw.type) {
    case "webhook":
      return { type: "webhook", provider: isProvider(raw.provider) ? raw.provider : "generic", input: str("input") || undefined };
    case "cron":
      return { type: "cron", schedule: str("schedule"), input: str("input"), timezone: str("timezone") || undefined };
    case "queue":
      return { type: "queue", name: str("name") };
    default:
      return { type: "http" };
  }
}

/** One-line description, e.g. "Webhook · GitHub" or "Queue tickets". */
export function describeTrigger(t: Trigger): string {
  switch (t.type) {
    case "webhook":
      return `Webhook · ${PROVIDER_LABEL[t.provider]}`;
    case "cron":
      return `Cron ${t.schedule}${t.timezone && t.timezone !== "UTC" ? ` (${t.timezone})` : ""}`;
    case "queue":
      return `Queue ${t.name}`;
    default:
      return "HTTP";
  }
}

/** Editable trigger row in a form. */
export interface TriggerDraft {
  key: string;
  type: TriggerType;
  provider: WebhookProvider;
  input: string;
  schedule: string;
  timezone: string;
  queue: string;
}

let draftSeq = 0;

export function newDraft(type: TriggerType = "http", init: Partial<TriggerDraft> = {}): TriggerDraft {
  draftSeq += 1;
  return {
    key: `t${draftSeq}`,
    type,
    provider: "github",
    input: "",
    schedule: type === "cron" ? "0 9 * * 1-5" : "",
    timezone: "UTC",
    queue: "",
    ...init,
  };
}

/** Validation message for a draft, or null. */
export function draftError(d: TriggerDraft): string | null {
  if (d.type === "cron") {
    const err = cronError(d.schedule);
    if (err) return err;
    if (!d.input.trim()) return "a cron trigger needs an input";
  }
  if (d.type === "queue" && !/^[A-Za-z0-9_.:-]+$/.test(d.queue.trim())) return "a queue needs a name (letters, digits, _ . : -)";
  return null;
}

/** API payload for a draft. */
export function draftToTrigger(d: TriggerDraft): Trigger {
  switch (d.type) {
    case "webhook":
      return d.input.trim() ? { type: "webhook", provider: d.provider, input: d.input } : { type: "webhook", provider: d.provider };
    case "cron":
      return { type: "cron", schedule: d.schedule.trim().replace(/\s+/g, " "), input: d.input, ...(d.timezone.trim() && d.timezone.trim() !== "UTC" ? { timezone: d.timezone.trim() } : {}) };
    case "queue":
      return { type: "queue", name: d.queue.trim() };
    default:
      return { type: "http" };
  }
}

export interface WebhookEndpoint {
  key: string;
  deployment: Deployment;
  provider: WebhookProvider;
  input?: string;
  url: string;
}

/** Every webhook trigger across deployments, as endpoints (`server` is the API base URL). */
export function webhookEndpoints(deployments: readonly Deployment[], server: string): WebhookEndpoint[] {
  const base = server.replace(/\/+$/, "");
  const out: WebhookEndpoint[] = [];
  for (const d of deployments) {
    d.triggers.forEach((raw, i) => {
      const t = parseTrigger(raw);
      if (t.type !== "webhook") return;
      out.push({ key: `${d.id}:${i}`, deployment: d, provider: t.provider, input: t.input, url: `${base}/v1/hooks/${d.id}` });
    });
  }
  return out;
}

/** Deployment names must be unique per project; suggest one from the agent and alias. */
export function suggestName(agent: string, alias: string, suffix = ""): string {
  return [agent, alias, suffix].filter(Boolean).join("-");
}
