#!/usr/bin/env bash
#
# Deliberate, GUARDED teardown of the cog-stac app.
#
# The application has independent read and ingest stacks. The per-account bucket
# is owned by the separate foundation stack and Retained on deletion.
#
# It does NOT touch the shared, author-published `cog-stac-catalog` bucket.
#
# Usage:
#   ./teardown.sh                # admin: delete app stacks + foundation + retained bucket
#   ./teardown.sh --keep-bucket  # delete only read + ingest stacks
#   ./teardown.sh --help
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${REGION:-us-west-2}"
READ_STACK="${READ_STACK:-cog-stac-read}"
INGEST_STACK="${INGEST_STACK:-cog-stac-ingest}"
FOUNDATION_STACK="${FOUNDATION_STACK:-cog-stac-foundation}"
KEEP_BUCKET=false

die() { echo "ERROR: $*" >&2; exit 1; }
for arg in "$@"; do
  case "$arg" in
    --keep-bucket) KEEP_BUCKET=true ;;
    --help|-h) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

command -v aws >/dev/null 2>&1 || die "aws CLI not found."
command -v sam >/dev/null 2>&1 || die "SAM CLI not found."
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "AWS credentials not working."
BUCKET="cog-stac-viewer-${ACCOUNT}-${REGION}"

echo "Account : $ACCOUNT"
echo "Region  : $REGION"
echo "Stacks  : $READ_STACK, $INGEST_STACK"
echo "Bucket  : s3://$BUCKET  ($([ "$KEEP_BUCKET" = true ] && echo "KEEP" || echo "DELETE + all data"))"
echo "Shared catalog bucket (cog-stac-catalog) is NOT touched."
echo

if [ "$KEEP_BUCKET" != true ]; then
  if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
    N="$(aws s3 ls --recursive "s3://$BUCKET" --region "$REGION" 2>/dev/null | wc -l | tr -d ' ')"
    echo "!!! This permanently deletes s3://$BUCKET and ALL $N objects in it"
    echo "    (the viewer files AND your private lake/ output)."
    printf 'Type the bucket name to confirm: '
    read -r CONFIRM
    [ "$CONFIRM" = "$BUCKET" ] || die "confirmation did not match the bucket name; aborting (nothing deleted)."
  else
    echo "Bucket s3://$BUCKET does not exist; will only delete the application stacks."
    KEEP_BUCKET=true
  fi
fi

echo
echo "==> Deleting read stack: $READ_STACK"
sam delete --stack-name "$READ_STACK" --region "$REGION" --no-prompts || \
  echo "  (read stack may already be gone; continuing)"

echo "==> Deleting ingest stack: $INGEST_STACK"
sam delete --stack-name "$INGEST_STACK" --region "$REGION" --no-prompts || \
  echo "  (ingest stack may already be gone; continuing)"

if [ "$KEEP_BUCKET" != true ]; then
  echo
  echo "==> Deleting foundation stack: $FOUNDATION_STACK"
  aws cloudformation delete-stack --stack-name "$FOUNDATION_STACK" --region "$REGION"
  aws cloudformation wait stack-delete-complete --stack-name "$FOUNDATION_STACK" \
    --region "$REGION" || die "foundation stack deletion failed"

  echo
  echo "==> Emptying s3://$BUCKET"
  aws s3 rm "s3://$BUCKET" --recursive --region "$REGION"
  echo "==> Deleting bucket s3://$BUCKET"
  aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION" || \
    die "delete-bucket failed (s3:DeleteBucket is bucket-admin -- re-run the rb with admin creds: aws s3 rb s3://$BUCKET --region $REGION)"
  echo
  echo "Done. Application stacks, foundation, and bucket data removed."
else
  echo
  echo "Done. Read and ingest stacks removed; foundation and s3://$BUCKET KEPT."
  echo "  Delete later: aws s3 rm s3://$BUCKET --recursive && aws s3 rb s3://$BUCKET --region $REGION"
fi
