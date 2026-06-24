#!/usr/bin/env bash
#
# Orchestrate the independently deployable ingest and read application stacks.
# The persistent viewer/output bucket remains in the separate admin-owned
# foundation stack. (S1M terrain discovery is now served by the read API, so
# there is no separate S1M stack.)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_READ=true
DEPLOY_INGEST=true
READ_ARGS=()

usage() {
  cat <<'EOF'
Usage: deploy.sh [OPTIONS]

By default: deploy ingest -> read -> publish viewer.

Options:
  --read-only       Deploy only the read stack and viewer
  --ingest-only     Deploy only the ingest stack
  --rebuild-layer   Force the read stack's DuckDB layer rebuild
  --no-viewer       Skip publishing the viewer after the read deploy
  --help            Print this message

Deployment order:
  foundation (admin, once) -> ingest -> read -> viewer
EOF
}

for arg in "$@"; do
  case "$arg" in
    --read-only) DEPLOY_INGEST=false ;;
    --ingest-only) DEPLOY_READ=false ;;
    --rebuild-layer|--no-viewer) READ_ARGS+=("$arg") ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ "$DEPLOY_READ" == false && "$DEPLOY_INGEST" == false ]]; then
  echo "ERROR: choose only one of --read-only or --ingest-only" >&2
  exit 1
fi

if [[ "$DEPLOY_READ" == false && ${#READ_ARGS[@]} -gt 0 ]]; then
  echo "ERROR: --rebuild-layer and --no-viewer apply only to read deployments" >&2
  exit 1
fi

if [[ "$DEPLOY_INGEST" == true ]]; then
  bash "$SCRIPT_DIR/deploy-ingest.sh"
fi

if [[ "$DEPLOY_READ" == true ]]; then
  bash "$SCRIPT_DIR/deploy-read.sh" "${READ_ARGS[@]}"
fi
