#!/usr/bin/env bash
# Keep the api container's lake credentials fresh automatically.
#
# Your `aws login` session is long-lived and the AWS CLI auto-refreshes its
# short (~15 min) temporary credentials -- but only on the host. The container
# can't participate in that refresh, so its file-copied creds go stale and the
# lake 503s / presigned tile URLs expire. This loop re-runs refresh-creds.sh on
# an interval so the container always has a valid, recently-minted credential
# for as long as you stay logged in -- no static IAM keys needed.
#
# Run it in a terminal (or `nohup ./auto-refresh-creds.sh &`) while you develop;
# Ctrl-C to stop. If your host login lapses, it keeps retrying and recovers once
# you re-login. Interval defaults to 600s (creds last ~15 min, so this keeps a
# comfortable buffer).
#
#   ./auto-refresh-creds.sh [interval-seconds]
#
# Trade-off: each refresh restarts the api container (~3s blip) to reset its
# cached connections. If you'd rather have zero churn, use a scoped read-only
# static IAM key instead (see README / the credentials discussion).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${1:-600}"

echo "Auto-refreshing lake creds every ${INTERVAL}s (Ctrl-C to stop)."
while true; do
  if "$DIR/refresh-creds.sh"; then
    echo "$(date '+%H:%M:%S') ok; next refresh in ${INTERVAL}s"
  else
    echo "$(date '+%H:%M:%S') refresh failed -- re-login on the host if needed; retrying in ${INTERVAL}s" >&2
  fi
  sleep "$INTERVAL"
done
