#!/usr/bin/env bash
# Refresh the api container's AWS credentials for the private lake bucket.
#
# Why this exists: the local viewer reads the GeoParquet lake (/collections,
# /search, /availability) and the S1M/buildings indexes from a private S3 bucket.
# The api container can't use the host's "login"-type credential helper, so it
# needs file-based creds. But writing those under the SAME profile name as your
# host login (korver-dev) shadows the login helper -- the credentials file wins,
# so `aws login` refreshes never take and you get ExpiredToken on a fresh login.
#
# So the container uses a DEDICATED profile (deckgl-s3-cog-s1m-local) that lives
# only in the credentials file, while your host keeps using korver-dev via the
# login helper. This script exports fresh creds from your live korver-dev login
# and writes them to [deckgl-s3-cog-s1m-local], leaving [korver-dev] untouched
# (and cleaning any stray copy).
#
# Run whenever the viewer shows ingested collections (NJ, KyFromAbove) as "not
# ingested" or the API returns 503 ExpiredToken. Prereq: you are logged in on the
# host (`aws sts get-caller-identity --profile <login profile>` returns your ARN).
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRED_FILE="${AWS_SHARED_CREDENTIALS_FILE:-$HOME/.aws/credentials}"

# The host login identity to copy creds FROM, and the dedicated file profile the
# container reads (must match AWS_PROFILE in app/.env).
LOGIN_PROFILE="${AWS_LOGIN_PROFILE:-korver-dev}"
CONTAINER_PROFILE="${AWS_CONTAINER_PROFILE:-deckgl-s3-cog-s1m-local}"

if [[ "$LOGIN_PROFILE" == "$CONTAINER_PROFILE" ]]; then
  echo "ERROR: LOGIN_PROFILE and CONTAINER_PROFILE must differ (they collide and shadow)." >&2
  exit 1
fi
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi

echo "Login profile:     $LOGIN_PROFILE (host)"
echo "Container profile: $CONTAINER_PROFILE (file)"

# Never let a stray [LOGIN_PROFILE] section sit in the file -- it shadows the
# host login helper, which is the bug this script exists to avoid.
python3 - "$CRED_FILE" "$LOGIN_PROFILE" <<'PY'
import configparser, sys
cred_file, login = sys.argv[1], sys.argv[2]
cp = configparser.ConfigParser(); cp.read(cred_file)
if cp.has_section(login):
    cp.remove_section(login)
    with open(cred_file, "w") as fh: cp.write(fh)
    print(f"  cleaned stray [{login}] from credentials file (was shadowing the login)")
PY

echo "Checking host login..."
if ! AWS_PROFILE="$LOGIN_PROFILE" aws sts get-caller-identity >/dev/null 2>&1; then
  echo "ERROR: profile '$LOGIN_PROFILE' is not authenticated (login session expired)." >&2
  echo "       Re-login on the host, confirm 'aws sts get-caller-identity --profile $LOGIN_PROFILE'," >&2
  echo "       then re-run this script." >&2
  exit 1
fi

echo "Exporting fresh credentials..."
creds_json="$(AWS_PROFILE="$LOGIN_PROFILE" aws configure export-credentials)"

echo "Writing [$CONTAINER_PROFILE] to credentials file..."
CREDS_JSON="$creds_json" python3 - "$CRED_FILE" "$CONTAINER_PROFILE" <<'PY'
import configparser, json, os, sys
cred_file, profile = sys.argv[1], sys.argv[2]
d = json.loads(os.environ["CREDS_JSON"])
cp = configparser.ConfigParser(); cp.read(cred_file)
if not cp.has_section(profile): cp.add_section(profile)
cp[profile]["aws_access_key_id"] = d["AccessKeyId"]
cp[profile]["aws_secret_access_key"] = d["SecretAccessKey"]
cp[profile]["aws_session_token"] = d["SessionToken"]
with open(cred_file, "w") as fh: cp.write(fh)
print("  expires", d.get("Expiration", "(static)"))
PY

echo "Restarting api container..."
( cd "$COMPOSE_DIR" && $DC restart api >/dev/null )

echo "Verifying lake access..."
ok=""
for i in $(seq 1 15); do
  code="$(curl -s -m 30 -o /dev/null -w '%{http_code}' http://localhost:8089/collections 2>/dev/null || true)"
  if [[ "$code" == "200" ]]; then ok="yes"; break; fi
  sleep 1
done

if [[ -n "$ok" ]]; then
  ids="$(curl -s -m 30 http://localhost:8089/collections \
    | python3 -c 'import sys,json; print(", ".join(c["id"] for c in json.load(sys.stdin).get("collections",[])))' 2>/dev/null || true)"
  echo "OK -- /collections reachable. Ingested collections: ${ids:-<none>}"
else
  echo "WARN: /collections still not 200 after restart. Check '$DC logs api'." >&2
  exit 1
fi
