# Architecture decision records

An ADR records one significant decision: the context that forced it, what was decided, and what follows from it. ADRs are short, numbered and never rewritten after acceptance; a changed decision gets a new ADR that supersedes the old one.

## Process

1. Copy [template.md](template.md) to `NNNN-short-title.md`, using the next free number.
2. Open it with status **Proposed** in a pull request. Discussion happens on the PR.
3. On merge, set the status to **Accepted** (or **Rejected**, kept for the record).
4. To change an accepted decision, write a new ADR and mark the old one **Superseded by ADR-NNNN**.

Statuses: `Proposed` · `Accepted` · `Rejected` · `Deprecated` · `Superseded by ADR-NNNN`.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-own-the-harness-inference-apis-only.md) | Own the harness; call only model inference APIs | Accepted |
| [0003](0003-native-features-through-adapters.md) | Native model features through adapters with capability manifests | Accepted |
| [0004](0004-registry-immutable-versions-and-aliases.md) | Registry of immutable, content-hashed versions with movable aliases | Accepted |
| [0005](0005-durable-execution-on-postgres.md) | Durable execution on a Postgres run queue behind `StepStore` | Proposed |
| [0006](0006-e2b-sandbox-per-session.md) | One E2B sandbox per session behind a pluggable `SandboxProvider` | Accepted |
| [0007](0007-routing-model.md) | Routing: `name@alias`, sticky weighted splits, model fallbacks | Accepted |
| [0008](0008-event-log-and-streaming.md) | Append-only session event log with resumable streaming | Accepted |
| [0009](0009-portable-built-in-tools.md) | Portable built-in tools run in our sandbox with vendor-native schemas | Accepted |
| [0010](0010-secrets-handling.md) | Secrets are encrypted and injected at the tool gateway only | Accepted |
| [0011](0011-runtime-owns-the-transcript.md) | The runtime owns the transcript, allowing model switches between runs | Accepted |
| [0012](0012-python-first-typescript-generated.md) | Python SDK first; TypeScript client generated from OpenAPI | Accepted |
| [0013](0013-skills-as-versioned-folders.md) | Skills as versioned folders with progressive loading | Accepted |
| [0014](0014-tool-approvals-as-policy.md) | Tool approvals as declarative policy that pauses the run | Accepted |
| [0015](0015-package-and-install-names.md) | Package and install names | Proposed |
| [0016](0016-license.md) | License | Proposed |
| [0017](0017-flagship-demo.md) | Flagship demo | Proposed |
| [0018](0018-durable-resume-by-deterministic-replay.md) | Durable resume by deterministic replay of keyed steps | Accepted |
| [0019](0019-child-runs-execute-inline.md) | Child runs from call_agent and spawn_subagent execute inline | Accepted |
| [0020](0020-approval-expression-language.md) | The approval `when` expression language | Accepted |

ADRs 0015 to 0017 and 0005 track the [open questions](../roadmap.md#open-questions) in the plan; each states a recommendation and must be decided before v0.1. The implementation follows the recommendations of ADR-0005 (Postgres queue) and ADR-0017 (incident-investigator demo). It still uses the placeholder `agents` import and package names, so accepting ADR-0015's fresh namespace means a rename, and accepting ADR-0016 means adding a `LICENSE` file.
