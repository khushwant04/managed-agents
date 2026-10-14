# `agents-base` sandbox template

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
make sandbox-image            # = docker build -t agents-base:latest infra/e2b
AGENTS_SANDBOX_PROVIDER=docker agents-server worker
```

`DockerSandboxProvider` uses the `agents-base:latest` image by default and runs
`sleep <timeout>` as the container command, so the image defines no `CMD`.

## E2B (production)

### Recommended: Template SDK (`build_template.py`)

E2B's current template system (Template SDK, `e2b>=2`) imports a single-stage
Dockerfile and builds it on E2B. `e2b` is already a dependency of
`managed-agents[e2b]`.

```bash
export E2B_API_KEY=e2b_...
uv run --no-project --with 'e2b>=2' python infra/e2b/build_template.py                 # builds `agents-base`
uv run --no-project --with 'e2b>=2' python infra/e2b/build_template.py --tag v0.1.0    # extra tag
uv run --no-project --with 'e2b>=2' python infra/e2b/build_template.py --dry-run       # parse only, no API call
```

Options: `--name` (default `agents-base`, or `E2B_TEMPLATE_NAME`), `--cpu` (2),
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
e2b template build             # reads e2b.toml (template_name = "agents-base", dockerfile = "Dockerfile")
```

E2B's docs now direct users to migrate (`e2b template migrate`, which generates
`template.py` + `build_dev.py`/`build_prod.py`) or to use `fromDockerfile()`,
which is what `build_template.py` does. The CLI writes `template_id` back into
`e2b.toml` after the first build. Prefer the SDK path above.

## Using a different template

Sandbox environments choose a template by name (`Environment.template`,
default `agents-base`). To roll out a new template without affecting running
sessions, build it under a new name or tag and point the environment at it.
