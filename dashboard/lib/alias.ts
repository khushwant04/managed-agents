/** Alias targets: promotion, canary splits and human-readable descriptions. */
import type { AliasInfo, AliasTarget, VersionWeight } from "./api";

export function promoteTarget(version: number): AliasTarget {
  if (!Number.isInteger(version) || version < 1) throw new Error("version must be a positive integer");
  return { versions: [{ version, weight: 100 }] };
}

/**
 * A canary split: `percent` of new sessions go to `canary`, the rest to
 * `stable`. 0 or 100 collapse to a single version.
 */
export function canaryTarget(stable: number, canary: number, percent: number): AliasTarget {
  if (!Number.isInteger(stable) || stable < 1 || !Number.isInteger(canary) || canary < 1) {
    throw new Error("pick two versions");
  }
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error("percent must be between 0 and 100");
  const p = Math.round(percent);
  if (stable === canary || p === 0) return promoteTarget(stable);
  if (p === 100) return promoteTarget(canary);
  return {
    versions: [
      { version: stable, weight: 100 - p },
      { version: canary, weight: p },
    ],
  };
}

export function weightOf(v: VersionWeight): number {
  return v.weight ?? 100;
}

/** "v3" or "v3 90% · v4 10%". */
export function describeTarget(versions: readonly VersionWeight[]): string {
  if (versions.length === 0) return "(none)";
  if (versions.length === 1) return `v${versions[0]!.version}`;
  return versions.map((v) => `v${v.version} ${weightOf(v)}%`).join(" · ");
}

/** Validation message for a target, or null when it is valid. */
export function validateTarget(target: AliasTarget): string | null {
  if (target.versions.length === 0) return "an alias needs at least one version";
  const seen = new Set<number>();
  let sum = 0;
  for (const v of target.versions) {
    if (seen.has(v.version)) return `v${v.version} appears twice`;
    seen.add(v.version);
    const w = weightOf(v);
    if (w < 0 || w > 100) return "weights must be between 0 and 100";
    sum += w;
  }
  if (sum !== 100) return `weights add up to ${sum}, not 100`;
  return null;
}

/** Aliases that currently route any traffic to `version`, with its weight. */
export function aliasesForVersion(aliases: readonly AliasInfo[], version: number): { alias: string; weight: number }[] {
  const out: { alias: string; weight: number }[] = [];
  for (const a of aliases) {
    const hit = a.versions.find((v) => v.version === version);
    if (hit) out.push({ alias: a.alias, weight: weightOf(hit) });
  }
  return out;
}

/** Alias names must be simple identifiers so they fit in `name@alias`. */
export function isValidAliasName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,62}$/i.test(name);
}
