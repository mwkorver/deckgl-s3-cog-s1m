#!/usr/bin/env bash
#
# Build and deploy only the container-image ingest stack.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${REGION:-us-west-2}"
STACK="${INGEST_STACK:-deckgl-s3-cog-s1m-ingest}"
FOUNDATION_STACK="${FOUNDATION_STACK:-deckgl-s3-cog-s1m-foundation}"

die() { echo "ERROR: $*" >&2; exit 1; }

command -v aws >/dev/null 2>&1 || die "aws CLI not found"
command -v sam >/dev/null 2>&1 || die "SAM CLI not found"

# SAM does not always discover a non-default Docker context. Colima exposes a
# stable socket that can be passed directly without affecting Docker Desktop.
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

echo "==> Build ingest stack ($STACK)"
cd "$SCRIPT_DIR"
sam build --template-file ingest-template.yaml

echo
echo "==> Deploy ingest stack ($STACK)"
sam deploy \
  --template-file .aws-sam/build/template.yaml \
  --stack-name "$STACK" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --resolve-image-repos \
  --confirm-changeset

INGEST_URL="$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='IngestUrl'].OutputValue" \
  --output text)"

[[ -n "$INGEST_URL" && "$INGEST_URL" != "None" ]] || \
  die "IngestUrl output missing from stack '$STACK'"

echo
echo "Ingest ready: $INGEST_URL"
