/**
 * Project policy keys the server enforces (registry.py, service.py, worker.py)
 * and a validator for the settings page's JSON editor.
 */

export interface PolicyKeyDoc {
  key: string;
  shape: string;
  description: string;
  example: unknown;
}

export const POLICY_KEYS: PolicyKeyDoc[] = [
  {
    key: "allowed_models",
    shape: "string[]",
    description: "Models an agent may use. Registration fails for any other model.",
    example: ["claude-sonnet-4-5", "claude-haiku-4-5"],
  },
  {
    key: "allowed_tools",
    shape: "string[]",
    description: "Tool names agents may declare (agent-call tools are always allowed).",
    example: ["shell", "files", "web_fetch"],
  },
  {
    key: "allowed_agents",
    shape: "string[]",
    description: "Agents that may be invoked in this project.",
    example: ["incident-investigator", "support-triage"],
  },
  {
    key: "agent_calls",
    shape: "{ [caller]: string[] }",
    description: "Which agents each calling agent may invoke as a subagent.",
    example: { "incident-investigator": ["code-reviewer"] },
  },
  {
    key: "budget",
    shape: "{ max_tokens: number, window?: string }",
    description: "Refuse new runs once input + output tokens in the window (default \"30 days\") reach the cap.",
    example: { max_tokens: 5_000_000, window: "30 days" },
  },
  {
    key: "egress_domains",
    shape: "string[]",
    description: "Hosts tool calls may reach; \"*.example.com\" matches subdomains. Omit to allow all.",
    example: ["api.github.com", "*.slack.com"],
  },
];

export interface PolicyCheck {
  /** The parsed policy when the text is a JSON object. */
  policy: Record<string, unknown> | null;
  /** Blocking problems (invalid JSON, not an object). */
  error: string | null;
  /** Non-blocking notes about known keys with the wrong shape or unknown keys. */
  warnings: string[];
}

const isStringArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse and check the editor's text. */
export function checkPolicy(text: string): PolicyCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim() === "" ? "{}" : text);
  } catch (e) {
    return { policy: null, error: e instanceof Error ? e.message : "Invalid JSON", warnings: [] };
  }
  if (!isPlainObject(parsed)) return { policy: null, error: "The policy must be a JSON object.", warnings: [] };

  const warnings: string[] = [];
  const known = new Set(POLICY_KEYS.map((k) => k.key));
  for (const [key, value] of Object.entries(parsed)) {
    if (!known.has(key)) {
      warnings.push(`"${key}" is not a key the server reads.`);
      continue;
    }
    if (value === null) continue;
    if ((key === "allowed_models" || key === "allowed_tools" || key === "allowed_agents" || key === "egress_domains") && !isStringArray(value)) {
      warnings.push(`"${key}" should be a list of strings.`);
    } else if (key === "agent_calls" && !(isPlainObject(value) && Object.values(value).every(isStringArray))) {
      warnings.push(`"agent_calls" should map each caller to a list of agent names.`);
    } else if (key === "budget") {
      if (!isPlainObject(value)) warnings.push(`"budget" should be an object.`);
      else {
        if (value.max_tokens !== undefined && (typeof value.max_tokens !== "number" || value.max_tokens < 0)) {
          warnings.push(`"budget.max_tokens" should be a positive number.`);
        }
        if (value.window !== undefined && typeof value.window !== "string") {
          warnings.push(`"budget.window" should be a Postgres interval string like "30 days".`);
        }
      }
    }
  }
  return { policy: parsed, error: null, warnings };
}

/** Add `key` with its example value when it's missing; returns the new text, or null if the text isn't an object. */
export function withPolicyKey(text: string, key: string): string | null {
  const { policy } = checkPolicy(text);
  if (!policy) return null;
  if (key in policy) return JSON.stringify(policy, null, 2);
  const doc = POLICY_KEYS.find((k) => k.key === key);
  return JSON.stringify({ ...policy, [key]: doc?.example ?? null }, null, 2);
}
