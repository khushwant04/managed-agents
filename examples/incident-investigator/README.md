# Incident investigator (flagship demo)

An on-call agent that investigates a production alert, finds the root cause with evidence, and writes
`/workspace/outputs/report.md`. It exercises most of the platform: built-in `shell` and `files` tools in
a sandbox, function tools that become signed webhooks when hosted, a runbooks skill loaded progressively,
subagents, model fallback (Claude first, GPT second), and HTTP, webhook and cron triggers.

The scenario (`scenarios/5xx_spike.json`) is recorded, so every run sees the same world: a deploy of
`checkout-api` at 09:12 (`deploy-4821`) introduced a `NullPointerException` in `DiscountResolver`, and
`service-api` returned 5xx for every cart request that touched it. Two decoys (an earlier `service-api`
deploy and a later `search` deploy) separate investigation from guessing.

## Run it locally

```bash
export ANTHROPIC_API_KEY=...   # and/or OPENAI_API_KEY
uv run agents run examples/incident-investigator/agent.py \
  "$(jq -r .alert examples/incident-investigator/scenarios/5xx_spike.json)" --outputs outputs/
cat outputs/report.md
```

`INVESTIGATOR_MODELS=claude-opus-5-5` limits the run to one model.

## Deploy it

```bash
docker compose up -d                                            # gateway, worker, scheduler, Postgres, MinIO
export AGENTS_BASE_URL=http://localhost:8080 AGENTS_API_KEY=ak_dev_admin
TOOLS_URL=http://tools:9000 uv run agents apply examples/incident-investigator/agent.py --promote prod
uv run agents deploy incident-investigator --http --webhook generic --cron "*/30 * * * *" --input "Check error budgets"
TOOL_SIGNING_SECRET=<webhook secret printed by deploy> uv run uvicorn tools_server:app --app-dir examples/incident-investigator --port 9000
uv run agents invoke incident-investigator@prod "service-api 5xx rate above 5% for 10 minutes"
```

### The chaos demo

Start the invocation above, then kill the worker mid-run:

```bash
docker compose kill worker && docker compose up -d worker
```

The run's lease expires, the new worker claims it, and the session resumes from its last completed
step; completed tool calls are not repeated (the event stream shows `session.status` with
`resumed: true`). The same scenario runs in CI as
`packages/agents-server/tests/test_worker.py::test_worker_killed_mid_run_is_resumed_by_another`.

## Benchmark Claude and GPT

```bash
uv run python examples/incident-investigator/benchmark.py --models claude-opus-5-5 gpt-6-astra --runs 3
```

Each run gets a fresh sandbox; the report is graded mechanically (right deploy, right service, the
exception, a rollback). Results land in `results/` as JSON plus a Markdown table: correctness, median
time, tokens and cost (from `prices.json`; add prices for any model you benchmark). `--scripted` checks
the harness without API keys.
