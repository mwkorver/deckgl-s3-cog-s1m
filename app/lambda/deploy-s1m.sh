#!/usr/bin/env bash
#
# Build and deploy only the container-image S1M terrain stack.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${REGION:-us-west-2}"
STACK="${S1M_STACK:-cog-stac-s1m}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
INDEX_BUCKET="${BUCKET:-cog-stac-viewer-${ACCOUNT_ID}-${REGION}}"
INDEX_KEY="lake/s1m/S1M_Products.parquet"
S1M_RESERVED_CONCURRENCY="${S1M_RESERVED_CONCURRENCY:--1}"
S1M_DEMO_TOKEN="${S1M_DEMO_TOKEN:-$(aws lambda get-function-configuration \
  --function-name cog-stac-s1m --region "$REGION" \
  --query 'Environment.Variables.S1M_DEMO_TOKEN' --output text 2>/dev/null || true)}"
if [[ -z "$S1M_DEMO_TOKEN" || "$S1M_DEMO_TOKEN" == "None" ]]; then
  S1M_DEMO_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
fi

die() { echo "ERROR: $*" >&2; exit 1; }

command -v aws >/dev/null 2>&1 || die "aws CLI not found"
command -v sam >/dev/null 2>&1 || die "SAM CLI not found"

if [[ -z "${DOCKER_HOST:-}" && -S "$HOME/.colima/default/docker.sock" ]]; then
  export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
fi
docker info >/dev/null 2>&1 || die "Docker daemon not running"
aws s3api head-object --bucket "$INDEX_BUCKET" --key "$INDEX_KEY" \
  --region "$REGION" >/dev/null 2>&1 || \
  die "S1M Parquet index missing: s3://${INDEX_BUCKET}/${INDEX_KEY}. Run ./publish-s1m-index.sh first."

echo "==> Build S1M stack ($STACK)"
cd "$SCRIPT_DIR"
sam build --template-file s1m-template.yaml

echo
echo "==> Deploy S1M stack ($STACK)"
sam deploy \
  --template-file .aws-sam/build/template.yaml \
  --stack-name "$STACK" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-image-repos \
  --resolve-s3 \
  --parameter-overrides "S1MDemoToken=$S1M_DEMO_TOKEN" "S1MReservedConcurrency=$S1M_RESERVED_CONCURRENCY" \
  --confirm-changeset

S1M_URL="$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='S1MApiUrl'].OutputValue" \
  --output text)"

[[ -n "$S1M_URL" && "$S1M_URL" != "None" ]] || \
  die "S1MApiUrl output missing from stack '$STACK'"

echo
echo "S1M terrain API ready: $S1M_URL"
echo "S1M demo token: $S1M_DEMO_TOKEN"
if [[ "$S1M_RESERVED_CONCURRENCY" == "-1" ]]; then
  echo "S1M reserved concurrency: unreserved"
else
  echo "S1M reserved concurrency: $S1M_RESERVED_CONCURRENCY"
fi
