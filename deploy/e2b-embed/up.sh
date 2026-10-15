#!/usr/bin/env bash
# Bring up Runhive on this host with a self-hosted E2B runtime (E2B Embed).
#
#   ./up.sh                 # everything: Embed, secrets, images, template, stack, check
#   ./up.sh --skip-embed    # Embed is already running (managed elsewhere)
#   ./up.sh --pull          # use published images (RUNHIVE_IMAGE / RUNHIVE_DASHBOARD_IMAGE) instead of building
#   ./up.sh --rebuild-template --skip-check
#
# Re-running is safe: every step is idempotent, and existing secrets in .env are kept.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

E2B_EMBED_REF="${E2B_EMBED_REF:-50fc41af77ff0877d4224e5e4ded5e7f308b5476}"
E2B_EMBED_DIR="${E2B_EMBED_DIR:-$HERE/embed}"
TEMPLATE="runhive-base"

skip_embed=0 pull=0 rebuild_template=0 skip_check=0
for arg in "$@"; do
  case "$arg" in
    --skip-embed) skip_embed=1 ;;
    --pull) pull=1 ;;
    --rebuild-template) rebuild_template=1 ;;
    --skip-check) skip_check=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Set KEY=VALUE in .env, replacing an existing line or appending one.
set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' .env > "$tmp"
    cat "$tmp" > .env && rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
get_env() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
# Random URL-safe string: rand <bytes of entropy> <length>.
rand() { local s; s="$(head -c "$1" /dev/urandom | base64 | tr -d '\n/+=')"; printf '%s' "${s:0:$2}"; }

embed() { docker compose -p e2b --project-directory "$E2B_EMBED_DIR" -f "$E2B_EMBED_DIR/compose.yaml" "$@"; }
stack() { docker compose -f "$HERE/compose.yaml" "$@"; }

# --- 0. Preflight -------------------------------------------------------------
step "Preflight"
command -v docker >/dev/null || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin (docker compose) is required"
command -v curl >/dev/null || die "curl is required"
[ "$(uname -s)" = Linux ] || die "E2B Embed needs a Linux host with KVM"
[ -e /dev/kvm ] || echo "WARNING: /dev/kvm is missing; Embed's preflight will stop and say how to enable KVM."

# --- 1. E2B Embed -------------------------------------------------------------
if [ "$skip_embed" = 0 ]; then
  step "E2B Embed (e2b-dev/runtime@${E2B_EMBED_REF:0:12}) in $E2B_EMBED_DIR"
  mkdir -p "$E2B_EMBED_DIR"
  if [ ! -f "$E2B_EMBED_DIR/compose.yaml" ] || [ "$(cat "$E2B_EMBED_DIR/.ref" 2>/dev/null)" != "$E2B_EMBED_REF" ]; then
    base="https://raw.githubusercontent.com/e2b-dev/runtime/${E2B_EMBED_REF}/embed/compose"
    curl -fsSL -o "$E2B_EMBED_DIR/compose.yaml" "$base/compose.yaml"
    # Keep a customised Embed .env (HUGEPAGES, E2B_DASHBOARD_HOST, ...) across ref bumps.
    [ -f "$E2B_EMBED_DIR/.env" ] && cp "$E2B_EMBED_DIR/.env" "$E2B_EMBED_DIR/.env.previous"
    curl -fsSL -o "$E2B_EMBED_DIR/.env" "$base/.env"
    echo "$E2B_EMBED_REF" > "$E2B_EMBED_DIR/.ref"
  fi
  # First run: host checks and setup, Firecracker artifacts, images, base template (a few minutes).
  embed up -d --wait --wait-timeout 1800
fi

# --- 2. Runhive settings (.env) -----------------------------------------------
step "Settings (.env)"
[ -f .env ] || { cp .env.example .env; chmod 600 .env; echo "created .env from .env.example"; }
[ -n "$(get_env POSTGRES_PASSWORD)" ] || set_env POSTGRES_PASSWORD "$(rand 48 32)"
[ -n "$(get_env MINIO_ROOT_PASSWORD)" ] || set_env MINIO_ROOT_PASSWORD "$(rand 48 32)"
[ -n "$(get_env RUNHIVE_MASTER_KEY)" ] || set_env RUNHIVE_MASTER_KEY "$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
[ -n "$(get_env RUNHIVE_BOOTSTRAP_KEY)" ] || set_env RUNHIVE_BOOTSTRAP_KEY "ak_$(rand 48 32)"
if [ -z "$(get_env RUNHIVE_PUBLIC_URL)" ]; then
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  set_env RUNHIVE_PUBLIC_URL "http://${host_ip:-localhost}:$(get_env GATEWAY_PORT | grep . || echo 8080)"
fi

# Embed's team API key, as Embed's `ready` service publishes it.
sdk_env="$(embed exec -T ready cat /run/e2b/sdk.env 2>/dev/null || true)"
e2b_key="$(printf '%s\n' "$sdk_env" | sed -n 's/^export E2B_API_KEY=//p' | tr -d "'\"")"
if [ -n "$e2b_key" ]; then
  set_env E2B_API_KEY "$e2b_key"
elif [ -z "$(get_env E2B_API_KEY)" ]; then
  die "could not read Embed's API key (docker compose -p e2b exec ready cat /run/e2b/sdk.env); set E2B_API_KEY in .env"
fi
if [ -z "$(get_env ANTHROPIC_API_KEY)" ] && [ -z "$(get_env OPENAI_API_KEY)" ]; then
  echo "NOTE: no ANTHROPIC_API_KEY or OPENAI_API_KEY in .env yet; agents can't call a model until you add one (then re-run ./up.sh)."
fi

# --- 3. Images ----------------------------------------------------------------
if [ "$pull" = 1 ]; then
  step "Pulling images"
  [ -n "$(get_env RUNHIVE_IMAGE)" ] && [ -n "$(get_env RUNHIVE_DASHBOARD_IMAGE)" ] \
    || die "--pull needs RUNHIVE_IMAGE and RUNHIVE_DASHBOARD_IMAGE in .env (for example ghcr.io/khushwant04/runhive-server:0.1.0)"
  stack pull gateway dashboard
else
  step "Building images (runhive-server, runhive-dashboard)"
  stack build migrate dashboard
fi

# --- 4. Sandbox template on Embed --------------------------------------------
step "Sandbox template '$TEMPLATE' on Embed"
key="$(get_env E2B_API_KEY)"
templates="$(curl -fsS -H "X-API-Key: $key" "http://127.0.0.1:3000/v2/templates?limit=100" 2>/dev/null \
  || curl -fsS -H "X-API-Key: $key" "http://127.0.0.1:3000/templates" 2>/dev/null || true)"
if [ "$rebuild_template" = 1 ] || ! printf '%s' "$templates" | grep -q "\"$TEMPLATE\""; then
  stack --profile tools run --rm template
else
  echo "already built (use --rebuild-template to rebuild)"
fi

# --- 5. Runhive stack ---------------------------------------------------------
step "Starting Runhive"
stack up -d --wait --remove-orphans

# --- 6. End-to-end check ------------------------------------------------------
if [ "$skip_check" = 0 ]; then
  step "runhive e2b check (from the worker network)"
  stack --profile tools run --rm check || die "the E2B check failed; see the FIX lines above and README.md#troubleshooting"
fi

public_url="$(get_env RUNHIVE_PUBLIC_URL)"
dash_host="${public_url#http://}"; dash_host="${dash_host%%:*}"
cat <<EOF

Runhive is up, with sandboxes on this host's E2B Embed.

  API        $public_url
  Dashboard  http://$dash_host:$(get_env DASHBOARD_PORT | grep . || echo 3100)
  Admin key  RUNHIVE_BOOTSTRAP_KEY in $HERE/.env
  E2B        http://$dash_host:3001   (Embed's dashboard; key: E2B_API_KEY in .env)

  export RUNHIVE_BASE_URL=$public_url RUNHIVE_API_KEY=\$(grep ^RUNHIVE_BOOTSTRAP_KEY= $HERE/.env | cut -d= -f2-)
  runhive apply examples/incident-investigator/agent.py --promote prod
EOF
