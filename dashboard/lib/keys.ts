/**
 * The API has no "list keys" endpoint, so the API keys page derives the list
 * from the audit log: `key.create` (target = key id, details.role) and
 * `key.revoke` entries, plus keys that show up as actors (`key:<id>`) without a
 * create entry (created at setup or by the CLI).
 */
import type { AuditEntry } from "./api";

export interface DerivedKey {
  id: string;
  role: string | null;
  /** When the key was created (from its `key.create` entry). */
  createdAt: string | null;
  /** Who created it (`key:<id>` actor). */
  createdBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  /** Most recent audit entry this key made. */
  lastSeenAt: string | null;
  /** "audit": created through POST /v1/keys; "actor": only seen acting. */
  origin: "audit" | "actor";
}

const KEY_ACTOR = /^key:(.+)$/;

/** Key id from an actor like `key:key_abc`, or null. */
export function actorKeyId(actor: string): string | null {
  return KEY_ACTOR.exec(actor)?.[1] ?? null;
}

/** Keys mentioned in the audit log. Entries may come in any order. */
export function deriveKeys(entries: readonly AuditEntry[]): DerivedKey[] {
  const sorted = [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const keys = new Map<string, DerivedKey>();
  const ensure = (id: string, origin: DerivedKey["origin"]) => {
    let k = keys.get(id);
    if (!k) {
      k = { id, role: null, createdAt: null, createdBy: null, revokedAt: null, revokedBy: null, lastSeenAt: null, origin };
      keys.set(id, k);
    }
    return k;
  };
  for (const e of sorted) {
    if (e.action === "key.create") {
      const k = ensure(e.target, "audit");
      k.origin = "audit";
      k.createdAt = e.at;
      k.createdBy = e.actor;
      const role = (e.details as { role?: unknown } | undefined)?.role;
      if (typeof role === "string") k.role = role;
    } else if (e.action === "key.revoke") {
      const k = ensure(e.target, "audit");
      k.revokedAt = e.at;
      k.revokedBy = e.actor;
    }
    const actor = actorKeyId(e.actor);
    if (actor) ensure(actor, "actor").lastSeenAt = e.at;
  }
  // Created keys newest first; keys only seen acting (set up outside the API) after them.
  const time = (k: DerivedKey) => Date.parse(k.createdAt ?? k.lastSeenAt ?? "") || 0;
  const rank = (k: DerivedKey) => (k.createdAt ? 0 : 1);
  return [...keys.values()].sort((a, b) => rank(a) - rank(b) || time(b) - time(a));
}
