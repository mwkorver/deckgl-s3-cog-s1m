#!/usr/bin/env bash
#
# Provision the FOUNDATION stack (cog-stac-foundation): the Retain'd viewer /
# app-output S3 bucket + the CloudFront CORS/cache proxy for public source COG
# buckets. ADMIN, one-time -- run BEFORE the per-account SAM app stack.
#
# Why separate from `sam deploy`: creating a bucket + a CloudFront distribution
# are rare, privileged, stateful ops. Keeping them here lets the day-to-day
# deploy role stay scoped (no s3:CreateBucket / cloudfront create).
#
# Usage (admin creds):
#   ./deploy-foundation.sh            # create only, or safely report existing state
#   ./deploy-foundation.sh --update   # explicitly update an existing foundation stack
#
# Safety rules:
#   * Existing foundation stack + no --update: print outputs and exit without changes.
#   * Existing legacy bucket or tile distribution + no foundation stack: refuse
#     to create duplicates. Import/migration must be performed deliberately.
#   * Empty account: create the foundation stack.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${REGION:-us-west-2}"
STACK="${FOUNDATION_STACK:-cog-stac-foundation}"
TEMPLATE="$SCRIPT_DIR/foundation.yaml"
APPLICATION_TAG="${APPLICATION_TAG:-deck.gl-s3-cog}"
UPDATE=false

die() { echo "ERROR: $*" >&2; exit 1; }

if [ "$REGION" != "us-west-2" ]; then
  die "Foundation deployment is restricted to us-west-2 (received REGION=$REGION)"
fi

for arg in "$@"; do
  case "$arg" in
    --update) UPDATE=true ;;
    --help|-h)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $arg" ;;
  esac
done

command -v aws >/dev/null 2>&1 || die "aws CLI not found."
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "AWS credentials not working (admin creds required for foundation)."
BUCKET="cog-stac-viewer-${ACCOUNT}-${REGION}"

echo "Account : $ACCOUNT"
echo "Region  : $REGION"
echo "Stack   : $STACK"
echo "Bucket  : $BUCKET"

STACK_EXISTS=false
aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1 \
  && STACK_EXISTS=true

if [ "$STACK_EXISTS" = true ] && [ "$UPDATE" = false ]; then
  echo
  echo "Foundation stack already exists. No changes made."
  echo "Use --update only when you intend to update its stateful resources."
  echo
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs" --output table
  exit 0
fi

if [ "$STACK_EXISTS" = false ]; then
  BUCKET_EXISTS=false
  aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1 \
    && BUCKET_EXISTS=true

  TILE_DISTRIBUTIONS=""
  DISTRIBUTION_IDS="$(aws cloudfront list-distributions \
    --query "DistributionList.Items[].Id" --output text 2>/dev/null || true)"
  for distribution_id in $DISTRIBUTION_IDS; do
    distribution_arn="arn:aws:cloudfront::${ACCOUNT}:distribution/${distribution_id}"
    application_value="$(aws cloudfront list-tags-for-resource \
      --resource "$distribution_arn" \
      --query "Tags.Items[?Key=='Application'].Value | [0]" \
      --output text 2>/dev/null || true)"
    if [ "$application_value" = "$APPLICATION_TAG" ]; then
      distribution_domain="$(aws cloudfront get-distribution \
        --id "$distribution_id" \
        --query "Distribution.DomainName" \
        --output text 2>/dev/null || true)"
      TILE_DISTRIBUTIONS+="${distribution_id}"$'\t'"${distribution_domain}"$'\n'
    fi
  done
  TILE_DISTRIBUTIONS="${TILE_DISTRIBUTIONS%$'\n'}"

  if [ "$BUCKET_EXISTS" = true ] || [ -n "$TILE_DISTRIBUTIONS" ]; then
    echo
    echo "REFUSED: legacy foundation resources already exist outside stack '$STACK'." >&2
    [ "$BUCKET_EXISTS" = true ] && echo "  bucket: s3://$BUCKET" >&2
    if [ -n "$TILE_DISTRIBUTIONS" ]; then
      echo "  CloudFront (Application=$APPLICATION_TAG):" >&2
      printf '%s\n' "$TILE_DISTRIBUTIONS" | sed 's/^/    /' >&2
    fi
    echo "No resources were created, updated, replaced, or deleted." >&2
    echo "Import or migrate these resources deliberately before creating the foundation stack." >&2
    exit 2
  fi
fi

echo
if [ "$UPDATE" = true ]; then
  echo "==> Explicit foundation update ($STACK)"
else
  echo "==> Create foundation stack ($STACK)"
fi
aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file "$TEMPLATE" \
  --region "$REGION"

echo
echo "==> Outputs"
aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs" --output table

echo
echo "Foundation ready. Next: deploy the application stacks (cd app/lambda && ./deploy.sh)."
