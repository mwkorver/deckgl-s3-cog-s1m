#!/usr/bin/env bash
#
# Build and deploy only the zip-based read stack, then optionally publish the
# static viewer. The ingest Function URL is read from the independent ingest
# stack and passed as a CloudFormation parameter.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${REGION:-us-west-2}"
STACK="${READ_STACK:-deckgl-s3-cog-s1m-read}"
INGEST_STACK="${INGEST_STACK:-deckgl-s3-cog-s1m-ingest}"
FOUNDATION_STACK="${FOUNDATION_STACK:-deckgl-s3-cog-s1m-foundation}"
BUDGET_ALERT_EMAIL="${BUDGET_ALERT_EMAIL:-}"
MONTHLY_BUDGET_USD="${MONTHLY_BUDGET_USD:-10}"
REBUILD_LAYER=false
DEPLOY_VIEWER=true

usage() {
  cat <<'EOF'
Usage: deploy-read.sh [OPTIONS]

Options:
  --rebuild-layer   Force rebuild of the DuckDB Lambda layer
  --no-viewer       Skip publishing the static viewer
  --help            Print this message

Environment:
  BUDGET_ALERT_EMAIL  Optional monthly budget notification address
  MONTHLY_BUDGET_USD  Budget limit when email is set (default: 10)
EOF
}

for arg in "$@"; do
  case "$arg" in
    --rebuild-layer) REBUILD_LAYER=true ;;
    --no-viewer) DEPLOY_VIEWER=false ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }

command -v aws >/dev/null 2>&1 || die "aws CLI not found"
command -v sam >/dev/null 2>&1 || die "SAM CLI not found"

if [[ -z "${DOCKER_HOST:-}" && -S "$HOME/.colima/default/docker.sock" ]]; then
  export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
fi
docker info >/dev/null 2>&1 || die "Docker daemon not running"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)" || \
  die "AWS credentials not working"
VIEWER_BUCKET="${VIEWER_BUCKET:-deckgl-s3-cog-s1m-${ACCOUNT_ID}-us-west2}"

if aws cloudformation describe-stacks --stack-name "$FOUNDATION_STACK" \
     --region "$REGION" >/dev/null 2>&1; then
  echo "==> Foundation stack present: $FOUNDATION_STACK"
elif aws s3api head-bucket --bucket "$VIEWER_BUCKET" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Legacy foundation resources detected: s3://$VIEWER_BUCKET"
else
  die "Neither foundation stack '$FOUNDATION_STACK' nor viewer bucket '$VIEWER_BUCKET' exists"
fi

INGEST_URL="$(aws cloudformation describe-stacks --stack-name "$INGEST_STACK" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='IngestUrl'].OutputValue" \
  --output text 2>/dev/null)" || \
  die "Ingest stack '$INGEST_STACK' not found; deploy it first with deploy-ingest.sh"

[[ -n "$INGEST_URL" && "$INGEST_URL" != "None" ]] || \
  die "IngestUrl output missing from stack '$INGEST_STACK'"

LAYER_PYTHON="$SCRIPT_DIR/build/layer/python"
if [[ "$REBUILD_LAYER" == true || ! -d "$LAYER_PYTHON" ]]; then
  echo "==> Build DuckDB Lambda layer"
  ARCH=arm64 bash "$SCRIPT_DIR/build-layer.sh"
else
  echo "==> DuckDB layer present; skipping rebuild"
fi

echo
echo "==> Build read stack ($STACK)"
cd "$SCRIPT_DIR"
sam build --template-file template.yaml

echo
echo "==> Deploy read stack ($STACK)"
PARAMETER_OVERRIDES="IngestUrl=$INGEST_URL"
if [[ -n "$BUDGET_ALERT_EMAIL" ]]; then
  PARAMETER_OVERRIDES+=" BudgetAlertEmail=$BUDGET_ALERT_EMAIL MonthlyBudgetUSD=$MONTHLY_BUDGET_USD"
fi
sam deploy \
  --template-file .aws-sam/build/template.yaml \
  --stack-name "$STACK" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides "$PARAMETER_OVERRIDES" \
  --confirm-changeset

if [[ "$DEPLOY_VIEWER" == true ]]; then
  STACK="$STACK" bash "$SCRIPT_DIR/deploy-viewer.sh"
else
  echo
  echo "Viewer publish skipped. Run: $SCRIPT_DIR/deploy-viewer.sh"
fi
