# Reference designs: Claude Managed Agents and OpenAI Agents API

Neither product is used at runtime ([ADR-0002](adr/0002-own-the-harness-inference-apis-only.md)); both are studied for their object model and operating lessons. They converged on the same four objects and on separating the harness from the sandbox, and this project copies that shape while owning every layer.

*Snapshot as of Oct 14, 2026; both products are in beta and change often.*

| Dimension | [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) | [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) |
| --- | --- | --- |
| Status | Beta, header `runhive-2026-04-01` | Public beta since Sep 10, 2026, header `OpenAI-Beta: agents=v1` |
| Core objects | Agent, Environment, Session, Events | Agent, Environment, Session, Events and items |
| Harness | Anthropic harness with caching and compaction | Open-source Codex harness, run by OpenAI |
| Agent definition | Created once, referenced by ID | Inline on the session or stored and reused |
| Built-in tools | Bash, file ops (read, write, edit, glob, grep), web search and fetch, MCP | Shell, web search, computer use, functions, MCP, plugins, tool search, programmatic tool calling |
| Skills | Agent-level skills, downloaded into the sandbox | `capability_directories` in the sandbox, plus plugins |
| Multi-agent | Subagents | `multi_agent` with `max_concurrent_subagents` |
| Memory | Memory stores mounted at `/mnt/memory/` | Session state and compaction; no separate store named |
| Secrets | Managed credentials | Vaults (`vault_ids`) |
| Self-hosted sandbox | Environment worker polls a work queue (`ant beta:worker poll`); outbound HTTPS only | `codex exec-server` per session over outbound WebSocket |
| Streaming | SSE, full event history fetchable | Stream plus webhooks |
| Scheduling | Scheduled deployments (cron) | Not in the API; webhooks for lifecycle |
| Steering | Send user events mid-run or interrupt | Mid-turn steering |
| Pricing | Tokens plus managed sandbox usage | Tokens plus tool and container rates, no API fee |
| Data limits | Not ZDR or HIPAA BAA eligible | US residency only, not ZDR, even when self-hosted |

## What we borrow

- Agent / Environment / Session / Event objects.
- Agents defined once and referenced by ID.
- An append-only event stream with steering and interrupt.
- Skills as folders loaded into a sandbox.
- Secrets kept out of model context.

## What we add

- A registry with versions, aliases and traffic splits.
- Routing across models from both vendors in one platform.
- Deployments with HTTP, webhook, cron and queue triggers.
- Full self-hosting, where session state lives in your Postgres and only model calls leave.
- Because the harness is ours, a session can switch between Claude and GPT between runs, which neither managed product allows ([ADR-0011](adr/0011-runtime-owns-the-transcript.md)).

## Sources

- [Claude Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)
- [Claude Managed Agents: self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
- [OpenAI: Introducing the Agents API](https://openai.com/index/introducing-the-agents-api/)
- [OpenAI Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview)
- [OpenAI Agents API: self-hosted sandboxes](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)
- [RuntimeWire: OpenAI managed agents and Agent Builder wind-down](https://runtimewire.com/article/openai-managed-agents-devday-2026)
- [Claude features overview (Messages API)](https://platform.claude.com/docs/en/build-with-claude/overview)
