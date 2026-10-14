# Model adapters and native capabilities

Adapters turn one normalized request (messages, tools, settings) into each vendor's raw API call and stream back normalized deltas. Native features are typed options on the agent, not hidden behind a lowest common denominator.

Decision record: [ADR-0003](../adr/0003-native-features-through-adapters.md).

| Adapter | API | Native features exposed | Notes |
| --- | --- | --- | --- |
| `anthropic` | [Messages API](https://platform.claude.com/docs/en/build-with-claude/overview) | Adaptive thinking and effort, prompt caching (automatic, 5 min, 1 hour), server tools (web search, web fetch, code execution), client tool schemas (bash, text editor, memory, computer use), tool search, programmatic tool calling, compaction and context editing (beta), structured outputs, citations | Most of these are ZDR-eligible; code execution, Files API, Agent Skills and the MCP connector are not, and the adapter flags them |
| `openai` | Responses API | Reasoning effort, built-in tools (web search, file search, code interpreter, shell, computer use, apply patch), remote MCP, tool search, programmatic tool calling, compaction, background mode, prompt caching | The runtime keeps the transcript; response IDs are only a cache optimization |
| `openai-compatible` | Chat Completions style | Tools and streaming | vLLM, Ollama, OpenRouter, other vendors' compatible endpoints |

## Mapping rules

- **Portable built-ins:** `shell`, `files` and `code` always execute in our E2B sandbox so behavior is identical across models; the adapter presents them with the schema each model was trained on (Claude's bash and text editor tools, OpenAI's shell and apply patch). See [ADR-0009](../adr/0009-portable-built-in-tools.md).
- **Web tools:** `web_search` and `web_fetch` use the vendor's server-side tool when present, otherwise our own search-API tool.
- **Reasoning:** `reasoning: 'low' | 'medium' | 'high'` maps to Claude's effort and OpenAI's reasoning effort.
- **Caching:** the Claude adapter places cache breakpoints; the OpenAI adapter relies on automatic prefix caching. The runtime keeps prefixes stable for both.
- **Escape hatch:** `model_options["anthropic"]` and `model_options["openai"]` pass raw fields through, flagged as non-portable.
- **Capability manifest:** static tables plus Claude's Models API `capabilities` object; registration rejects an agent whose features its models can't serve.

## Normalized deltas

Every adapter yields the same delta kinds, which the runtime turns into [events](core-abstractions.md#event-schema):

| Delta | Becomes |
| --- | --- |
| `text` | `message.agent.delta` |
| `thinking` | `thinking.delta` (when exposed) |
| `tool_call` | `tool.call` |
| `usage` | accumulated into `run.finished` usage and per-step usage records |

## Switching models

Because the runtime owns the transcript ([ADR-0011](../adr/0011-runtime-owns-the-transcript.md)), a session may change model between runs, for example GPT to plan and Claude to execute. Vendor-specific blocks such as thinking signatures are dropped when crossing vendors, and the prompt cache starts cold.

## Testing adapters

- Contract tests per adapter on **recorded responses** (stored in object storage, replayed by pytest fixtures), so contributors need no API keys.
- Nightly live tests against real APIs catch vendor changes.
- Vendor SDKs are pinned.
