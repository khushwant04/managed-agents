# `runhive-base` sandbox template

Every session's sandbox starts from this image ([ADR-0006](../../docs/adr/0006-e2b-sandbox-per-session.md)):
Ubuntu 24.04, bash, Python 3 (+ pip, venv, a writable venv at `/opt/venv` on `PATH`),
Node.js LTS (NodeSource, major set by `NODE_MAJOR`, default 24), git, curl, jq,
ripgrep and build-essential. Commands run as the non-root `user`, which owns:

```text
/workspace
├── inputs/
├── outputs/
├── skills/
└── memory/
```

The same `Dockerfile` serves both sandbox providers.

## Docker provider (local development)

```bash
make sandbox-image            # = docker build -t runhive-base:latest infra/e2b
RUNHIVE_SANDBOX_PROVIDER=docker runhive-server worker
```

`DockerSandboxProvider` uses the `runhive-base:latest` image by default and runs
`sleep <timeout>` as the container command, so the image defines no `CMD`.

## E2B (production)

### Recommended: Template SDK (`build_template.py`)

E2B's current template system (Template SDK, `e2b>=2`) imports a single-stage
Dockerfile and builds it on E2B. `e2b` is already a dependency of
`runhive[e2b]`.

```bash
export E2B_API_KEY=e2b_...
uv run --no-project --with 'e2b>=2' python infra/e2b/build_template.py                 # builds `runhive-base`
uv run --no-project --with 'e2b>=2' python infra/e2b/build_template.py --tag v0.1.0    # extra tag
uv run --no-project --with 'e2b>=2' python infra/e2b/build_template.py --dry-run       # parse only, no API call
```

Options: `--name` (default `runhive-base`, or `E2B_TEMPLATE_NAME`), `--cpu` (2),
`--memory-mb` (2048), `--skip-cache`. The release workflow runs this on `v*`
tags when the `E2B_API_KEY` repository secret is set.

Verified locally against `e2b` 2.56.0: `Template().from_dockerfile(...)` parses
this file (checked with `--dry-run`) and `Template.build(template, name, tags=...,
cpu_count=..., memory_mb=...)` is the SDK's build call. The actual build against
E2B's API was not run (needs credentials).

Constraints from E2B's Dockerfile import, which this file respects:

- one `FROM` (no multi-stage); `RUN --mount` is ignored;
- `ARG` values become sandbox environment variables;
- `CMD`/`ENTRYPOINT` become the sandbox start command, so there are none;
- `${PATH}` in `ENV` is passed through unexpanded, so `PATH` is written out in full;
- if the Dockerfile sets no `USER`/`WORKDIR`, E2B defaults to `user` and
  `/home/user`; this one sets `user` and `/workspace` explicitly.

### Legacy: E2B CLI (`e2b.toml`)

**Uncertain — not verified.** Older E2B CLI releases build from `e2b.toml` +
a Dockerfile:

```bash
npm i -g @e2b/cli
e2b auth login                 # or: export E2B_ACCESS_TOKEN=...
cd infra/e2b
e2b template build             # reads e2b.toml (template_name = "runhive-base", dockerfile = "Dockerfile")
```

E2B's docs now direct users to migrate (`e2b template migrate`, which generates
`template.py` + `build_dev.py`/`build_prod.py`) or to use `fromDockerfile()`,
which is what `build_template.py` does. The CLI writes `template_id` back into
`e2b.toml` after the first build. Prefer the SDK path above.

## Self-hosted: E2B Embed

[E2B Embed](https://github.com/e2b-dev/runtime/tree/main/embed) runs the whole E2B runtime
(API, Firecracker orchestrator, sandbox proxy, template builder, dashboard) on one Linux host
with KVM, with the same SDK and API as E2B Cloud. The platform needs no code change to use it,
only two more variables next to `E2B_API_KEY`.

For a complete install on one host (Embed, the `runhive-base` template, and Runhive's API, workers
and dashboard wired to it) use [`deploy/e2b-embed`](../../deploy/e2b-embed/README.md): `make embed-stack-up`.
To run only Embed and point an existing Runhive at it:

```bash
make e2b-embed-up                         # downloads embed/compose pinned to E2B_EMBED_REF, docker compose up
eval "$(make -s e2b-embed-env)"           # E2B_API_KEY, E2B_API_URL (:3000), E2B_SANDBOX_URL (:3002)
make e2b-template                         # build runhive-base on your install
make e2b-check                            # verify it end to end (below)
```

For the platform's workers, set `E2B_API_URL` and `E2B_SANDBOX_URL` in `.env` (Compose) or
`config.e2b.apiUrl` / `config.e2b.sandboxUrl` (Helm). Embed's own requirements, ports and
troubleshooting are in its [compose guide](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md).
Embed serves plain HTTP, so keep it inside your network.

## Checking a setup

`runhive e2b check` (or `make e2b-check`) verifies that agents will run on an E2B setup, E2B Cloud
or self-hosted. It goes through the platform's own E2B provider and built-in tools, not just the SDK:

| Check | What it proves |
| --- | --- |
| configuration | `E2B_API_KEY` is set, and `E2B_SANDBOX_URL` accompanies `E2B_API_URL` |
| api reachable | the API answers and accepts the key (`GET /v2/templates`) |
| template ready | `runhive-base` (or `--template`) exists and its build is ready |
| create sandbox | a sandbox starts from it, with the `/workspace` layout created |
| workspace layout | `/workspace/{inputs,outputs,skills,memory}` exist and are writable by the sandbox user |
| toolchain | bash, python3, node and git are present (warnings on a stock template) |
| commands | exit codes, stderr and timeouts come back correctly |
| files | binary files round-trip byte for byte |
| built-in tools | the `shell`, `files` and `code` tools work in the sandbox |
| pause and resume | `/workspace` survives a pause (skip with `--no-pause`) |
| egress allowlist | with `--egress`: an allowed host is reachable and others are blocked |

Failures print a `FIX:` line. `--json` prints a machine-readable report.

The [`e2b-embed` workflow](../../.github/workflows/e2b-embed.yml) runs all of this in CI: it starts
Embed on the runner, runs Embed's own smoke test as a baseline, builds `runhive-base`, then runs
`runhive e2b check --egress` and the live E2B test. Embed needs KVM, so point the repository
variable `E2B_EMBED_RUNNER` at a self-hosted KVM runner, as E2B's own CI does.

## Using a different template

Sandbox environments choose a template by name (`Environment.template`,
default `runhive-base`). To roll out a new template without affecting running
sessions, build it under a new name or tag and point the environment at it.
