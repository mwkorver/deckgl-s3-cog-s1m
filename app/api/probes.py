import os
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import boto3
from aws_s3 import get_aws_credentials, get_s3_direct_client
from botocore.exceptions import BotoCoreError, ClientError
from config import (
    COLLECTION_ID,
    EARTHSEARCH_API,
    EARTHSEARCH_PAGE_SIZE,
    INGEST_MODE,
    INGEST_TOKEN,
    INGEST_URL,
    LAKE_ROOT,
    MANIFEST_INDEX,
    MANIFEST_SOURCE,
    PRESIGN_CACHE_MAXSIZE,
    PRESIGN_CACHE_TTL,
    PRESIGN_EXPIRES,
    PRESIGN_MAX_WORKERS,
    REQUEST_PAYER,
    SIGN_ASSET_URLS,
)
from lake import get_lake_duckdb


def infer_auth_mode():
    profile = os.environ.get("AWS_PROFILE")
    if profile:
        return f"profile:{profile}"
    if os.environ.get("AWS_WEB_IDENTITY_TOKEN_FILE"):
        return "web-identity"
    if os.environ.get("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") or os.environ.get("AWS_CONTAINER_CREDENTIALS_FULL_URI"):
        return "container-role"
    return "ambient-or-role"


def probe_earthsearch():
    request = Request(
        EARTHSEARCH_API,
        data=b'{"collections":["naip"],"limit":1}',
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=10) as response:
            return {
                "ok": True,
                "status_code": getattr(response, "status", None),
                "url": EARTHSEARCH_API,
            }
    except HTTPError as exc:
        return {"ok": False, "status_code": exc.code, "error": str(exc), "url": EARTHSEARCH_API}
    except URLError as exc:
        return {"ok": False, "error": str(exc), "url": EARTHSEARCH_API}


def probe_s3_access():
    try:
        row = (
            get_lake_duckdb()
            .cursor()
            .execute(
                f"""
                select asset_href
                from read_parquet('{LAKE_ROOT}/collection=*/**/*.parquet', hive_partitioning=true)
                where asset_href like 's3://%'
                order by source_key asc
                limit 1
                """
            )
            .fetchone()
        )
    except Exception as exc:
        return {"ok": False, "error": f"Lake probe query failed: {exc}", "request_payer": REQUEST_PAYER}
    if not row:
        return {"ok": False, "error": "No S3-backed assets available for probe.", "request_payer": REQUEST_PAYER}

    href = row[0]
    parsed = urlparse(href)
    params: dict[str, Any] = {"Bucket": parsed.netloc, "Key": parsed.path.lstrip("/")}
    if REQUEST_PAYER:
        params["RequestPayer"] = REQUEST_PAYER
    try:
        get_s3_direct_client().head_object(**params)
        return {
            "ok": True,
            "bucket": params["Bucket"],
            "key": params["Key"],
            "request_payer": REQUEST_PAYER,
        }
    except (BotoCoreError, ClientError) as exc:
        return {
            "ok": False,
            "bucket": params["Bucket"],
            "key": params["Key"],
            "request_payer": REQUEST_PAYER,
            "error": str(exc),
        }


def probe_manifest_index():
    """Confirm the Parquet manifest index is reachable by listing parquet files."""
    is_s3 = str(MANIFEST_INDEX).startswith("s3://")
    if not is_s3 and not Path(MANIFEST_INDEX).exists():
        return {"ok": False, "path": str(MANIFEST_INDEX), "error": "manifest index path does not exist"}
    glob = f"{MANIFEST_INDEX}/**/*.parquet"
    try:
        count = get_lake_duckdb().cursor().execute(f"select count(*) from glob('{glob}')").fetchone()[0]
    except Exception as exc:
        return {"ok": False, "path": str(MANIFEST_INDEX), "error": f"manifest index probe failed: {exc}"}
    if not count:
        return {
            "ok": False,
            "path": str(MANIFEST_INDEX),
            "file_count": 0,
            "error": "no parquet files found under manifest index",
        }
    result = {"ok": True, "path": str(MANIFEST_INDEX), "file_count": int(count)}
    result.update(probe_manifest_freshness())
    return result


def _parse_s3_uri(uri: str) -> tuple[str, str]:
    rest = uri[len("s3://") :]
    bucket, _, key = rest.partition("/")
    return bucket, key


def probe_manifest_freshness() -> dict[str, Any]:
    """Compare the published manifest LastModified to the newest index object."""
    if not (str(MANIFEST_SOURCE).startswith("s3://") and str(MANIFEST_INDEX).startswith("s3://")):
        return {}
    out: dict[str, Any] = {"source": str(MANIFEST_SOURCE)}
    try:
        s3 = get_s3_direct_client()
        src_bucket, src_key = _parse_s3_uri(MANIFEST_SOURCE)
        src = s3.head_object(Bucket=src_bucket, Key=src_key, RequestPayer="requester")
        source_modified = src["LastModified"]
        out["source_modified"] = source_modified.isoformat()

        idx_bucket, idx_prefix = _parse_s3_uri(MANIFEST_INDEX.rstrip("/"))
        newest = None
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=idx_bucket, Prefix=idx_prefix + "/", RequestPayer="requester"):
            for obj in page.get("Contents", []):
                lm = obj["LastModified"]
                if newest is None or lm > newest:
                    newest = lm
        if newest is not None:
            out["index_built"] = newest.isoformat()
            out["stale"] = source_modified > newest
    except Exception as exc:
        out["freshness_error"] = str(exc)
    return out


def ingest_token_hint() -> str | None:
    """The command an operator runs to read the ingest token back.

    Only meaningful on Lambda, where AWS_LAMBDA_FUNCTION_NAME names the function
    whose environment holds the token. Locally there is nothing to retrieve --
    require_ingest_token skips auth entirely when no token is configured.
    """
    function_name = os.environ.get("AWS_LAMBDA_FUNCTION_NAME")
    if not function_name:
        return None
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-west-2"
    return (
        f"aws lambda get-function-configuration --function-name {function_name} "
        f"--region {region} --query 'Environment.Variables.S3_COG_INGEST_TOKEN' --output text"
    )


def build_environment_payload():
    db_status = {"ok": False}
    auth_identity: dict[str, Any] | None = None
    auth_error = None
    s3_status: dict[str, Any] = {"ok": False, "error": "Lake probe not attempted."}
    try:
        get_lake_duckdb().cursor().execute("select 1").fetchone()
        db_status = {"ok": True, "engine": "duckdb", "lake_root": LAKE_ROOT}
        s3_status = probe_s3_access()
    except Exception as exc:
        db_status = {"ok": False, "error": str(exc)}
        s3_status = {"ok": False, "error": "Skipped because DuckDB health check failed."}

    try:
        auth_identity = boto3.client("sts", **get_aws_credentials()).get_caller_identity()
    except Exception as exc:
        auth_error = str(exc)

    return {
        "auth_mode": infer_auth_mode(),
        "auth_identity": {
            "ok": auth_identity is not None,
            "arn": auth_identity.get("Arn") if auth_identity else None,
            "account": auth_identity.get("Account") if auth_identity else None,
            "error": auth_error,
        },
        "s3_access_status": s3_status,
        "manifest_index": probe_manifest_index(),
        "db": db_status,
        "earthsearch": probe_earthsearch(),
        "ingest_mode": INGEST_MODE,
        "ingest_url": INGEST_URL or None,
        # How to retrieve the write token -- never the token itself. The viewer
        # does not ship it (a public bucket cannot hold a secret), so an operator
        # needs some way to find it. It lives in this function's own environment,
        # the one place it must exist anyway, and the runtime hands us our own
        # name, so this hint needs no configuration to stay correct. Reading it
        # back requires lambda:GetFunctionConfiguration -- IAM.
        "ingest_token_required": bool(INGEST_TOKEN),
        "ingest_token_hint": ingest_token_hint(),
        "effective_config": {
            "collection_id": COLLECTION_ID,
            "aws_region": os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION"),
            "sign_asset_urls": SIGN_ASSET_URLS,
            "presign_expires": PRESIGN_EXPIRES,
            "presign_cache_ttl": PRESIGN_CACHE_TTL,
            "presign_cache_maxsize": PRESIGN_CACHE_MAXSIZE,
            "presign_max_workers": PRESIGN_MAX_WORKERS,
            "request_payer": REQUEST_PAYER,
            "manifest_index": str(MANIFEST_INDEX),
            "earthsearch_api": EARTHSEARCH_API,
            "earthsearch_page_size": EARTHSEARCH_PAGE_SIZE,
        },
    }
