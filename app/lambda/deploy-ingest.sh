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

# Resolve the ingest token, in priority order:
#   1. S3_COG_INGEST_TOKEN in the environment (explicit override),
#   2. the value already stored in SSM from a previous deploy (so redeploying
#      does not invalidate the token pasted into a running browser session),
#   3. a freshly generated one.
# It is stored as a SecureString rather than only living in the Lambda env so it
# can be retrieved later without a redeploy, and so retrieving it requires IAM --
# which is the same gate that should protect the write endpoints.
TOKEN_PARAM="${S3_COG_INGEST_TOKEN_PARAM:-/${STACK}/ingest-token}"
INGEST_TOKEN="${S3_COG_INGEST_TOKEN:-}"
TOKEN_ORIGIN="environment"

if [[ -z "$INGEST_TOKEN" ]]; then
  INGEST_TOKEN="$(aws ssm get-parameter --name "$TOKEN_PARAM" --with-decryption \
    --region "$REGION" --query Parameter.Value --output text 2>/dev/null || true)"
  TOKEN_ORIGIN="existing SSM parameter"
fi
if [[ -z "$INGEST_TOKEN" || "$INGEST_TOKEN" == "None" ]]; then
  command -v openssl >/dev/null 2>&1 || die "openssl not found (needed to generate an ingest token)"
  INGEST_TOKEN="$(openssl rand -hex 32)"
  TOKEN_ORIGIN="newly generated"
fi

aws ssm put-parameter --name "$TOKEN_PARAM" --value "$INGEST_TOKEN" \
  --type SecureString --overwrite --region "$REGION" >/dev/null || \
  die "could not write $TOKEN_PARAM to SSM"

PARAMETER_OVERRIDES=("IngestToken=$INGEST_TOKEN" "IngestTokenParam=$TOKEN_PARAM")
DEPLOY_ARGS=()
if [[ ${#PARAMETER_OVERRIDES[@]} -gt 0 ]]; then
  DEPLOY_ARGS+=(--parameter-overrides "${PARAMETER_OVERRIDES[@]}")
fi
sam deploy \
  --template-file .aws-sam/build/template.yaml \
  --stack-name "$STACK" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --resolve-image-repos \
  "${DEPLOY_ARGS[@]}" \
  --no-fail-on-empty-changeset \
  --confirm-changeset

INGEST_URL="$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='IngestUrl'].OutputValue" \
  --output text)"

[[ -n "$INGEST_URL" && "$INGEST_URL" != "None" ]] || \
  die "IngestUrl output missing from stack '$STACK'"

echo
echo "Ingest ready: $INGEST_URL"
echo "Ingest token: $TOKEN_ORIGIN, stored at $TOKEN_PARAM (not shown here)"
echo "  The viewer does NOT ship the token -- paste it into the ingest panel's"
echo "  \"Ingest token\" field once per browser session. Retrieve it with:"
echo
echo "    aws ssm get-parameter --name $TOKEN_PARAM --with-decryption \\"
echo "      --region $REGION --query Parameter.Value --output text"
echo
