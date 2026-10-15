#!/usr/bin/env bash
# Stop Runhive (and optionally E2B Embed) on this host.
#
#   ./down.sh            # stop the Runhive stack; data is kept
#   ./down.sh --embed    # also stop E2B Embed; its data is kept
#   ./down.sh --purge    # remove both stacks' volumes and undo Embed's host setup
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2B_EMBED_DIR="${E2B_EMBED_DIR:-$HERE/embed}"

embed_too=0 purge=0
for arg in "$@"; do
  case "$arg" in
    --embed) embed_too=1 ;;
    --purge) embed_too=1; purge=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

embed() { docker compose -p e2b --project-directory "$E2B_EMBED_DIR" -f "$E2B_EMBED_DIR/compose.yaml" "$@"; }

if [ "$purge" = 1 ]; then
  docker compose -f "$HERE/compose.yaml" --profile tools down -v --remove-orphans
else
  docker compose -f "$HERE/compose.yaml" --profile tools down --remove-orphans
fi

if [ "$embed_too" = 1 ] && [ -f "$E2B_EMBED_DIR/compose.yaml" ]; then
  if [ "$purge" = 1 ]; then
    embed down -v
    embed --profile purge run --rm host-teardown
  else
    embed down
  fi
fi
