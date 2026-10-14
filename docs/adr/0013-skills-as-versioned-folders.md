# ADR-0013: Skills as versioned folders with progressive loading

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** [Tools, skills and memory](../architecture/tools-skills-memory.md#skills), ADR-0004, ADR-0006

## Context

Agents need reusable know-how (runbooks, scripts) that is too large to put in every system prompt. Claude's Agent Skills and OpenAI's `capability_directories` both load folders into the sandbox, but each is vendor-specific and some are not ZDR-eligible.

## Decision

A **skill** is a versioned folder (`SKILL.md` plus scripts), registered and versioned like an agent. At session start it is copied to `/workspace/skills/<name>`. The runtime lists each skill's name and description in the system prompt, and the model opens `SKILL.md` only when it needs it.

This progressive loading uses only the portable `files` and `shell` tools, so it works on any model.

## Alternatives considered

- **Vendor skill features.** Native but non-portable, and not available on OpenAI-compatible models.
- **Inline everything in instructions.** Wastes context and cache on every call.

## Consequences

- Skill bundles are stored in object storage and referenced by version from agent versions.
- Skill quality depends on good descriptions, since that is all the model sees up front.
