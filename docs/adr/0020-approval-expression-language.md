# ADR-0020: The approval `when` expression language

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** @khushwant04
- **Related:** ADR-0014

## Context

ADR-0014 introduced `approval: { when: <expr> }` and left the syntax open. Expressions are written by agent authors, stored in agent versions and evaluated by workers on every tool call, so they must be safe to evaluate and easy to read.

## Decision

A small subset of Python expression syntax, parsed with `ast` and evaluated by a whitelisting interpreter (never `eval`):

- Names: `args` (the call's arguments; keys readable as attributes, missing keys are `None`) and `tool` (the canonical tool name).
- Literals, lists, `and`/`or`/`not`, comparisons including `in`/`not in`, indexing, `len()`, and the string methods `startswith`, `endswith`, `lower`, `upper`, `strip`.
- Anything else (calls, attributes starting with `_`, comprehensions, lambdas, imports) is rejected at registration. A comparison between incompatible types is false. An expression that fails at run time **requires approval** (fail safe).

```yaml
approval: {when: "'rm ' in args.command or args.command.startswith('git push')"}
approval: {when: "args.amount > 100 and tool == 'pay'"}
```

MCP tools (`<server>__<tool>`) use the policy on their server's tool reference.

## Consequences

- Policies are portable data: no code runs on workers from agent definitions.
- Richer policies (time windows, caller identity) need new names in the environment, added in a later ADR.
