import configparser
import json
import os
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import Any
from urllib.parse import urlparse

import boto3
from botocore.exceptions import BotoCoreError, CredentialRetrievalError
from fastapi import HTTPException

from config import (
    PRESIGN_CACHE_MAXSIZE,
    PRESIGN_CACHE_TTL,
    PRESIGN_EXPIRES,
    PRESIGN_MAX_WORKERS,
    REQUEST_PAYER,
    SIGN_ASSET_URLS,
)


_cached_creds = None  # (access_key_id, secret_access_key, session_token, expires_ts)
_global_s3_client = None
_global_s3_client_lock = Lock()
_global_s3_client_creds_expiry = 0.0
_global_s3_direct_client = None
_global_s3_direct_client_lock = Lock()
_global_s3_direct_client_creds_expiry = 0.0
_presign_cache: OrderedDict[str, tuple[float, str, dict[str, str]]] = OrderedDict()
_presign_cache_lock = Lock()


def get_aws_credentials_expiry() -> float | None:
    return _cached_creds[3] if _cached_creds else None


def reset_aws_credentials_cache():
    global _cached_creds
    _cached_creds = None


def load_login_session_credentials(profile_name: str) -> tuple[str, str, str, float] | None:
    home = Path(os.environ.get("HOME", "/root"))
    cache_dir = home / ".aws" / "login" / "cache"
    if not cache_dir.exists():
        return None

    target_account_id = None
    config_path = Path(os.environ.get("AWS_CONFIG_FILE", home / ".aws" / "config"))
    if config_path.exists():
        parser = configparser.RawConfigParser()
        parser.read(config_path)
        section_name = profile_name if profile_name == "default" else f"profile {profile_name}"
        if parser.has_section(section_name):
            login_session = parser.get(section_name, "login_session", fallback="").strip()
            if login_session.startswith("arn:"):
                arn_parts = login_session.split(":")
                if len(arn_parts) > 4 and arn_parts[4]:
                    target_account_id = arn_parts[4]

    fallback_creds = None
    for json_file in sorted(cache_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = json.loads(json_file.read_text())
            access_token = data.get("accessToken", {})
            access_key_id = access_token.get("accessKeyId")
            secret_access_key = access_token.get("secretAccessKey")
            session_token = access_token.get("sessionToken")
            expires_at_str = access_token.get("expiresAt")
            account_id = access_token.get("accountId")
            if not (access_key_id and secret_access_key and session_token and expires_at_str):
                continue
            # expiresAt is UTC (trailing Z): parse tz-aware so .timestamp() is
            # correct. Parsing naive (stripping Z) treats it as local time, which
            # on a UTC-negative host over-reports validity by the UTC offset.
            expires_at_ts = datetime.fromisoformat(expires_at_str.replace("Z", "+00:00")).timestamp()
            if expires_at_ts <= time.time() + 30:
                continue
            creds = (access_key_id, secret_access_key, session_token, expires_at_ts)
            if target_account_id and account_id == target_account_id:
                return creds
            if fallback_creds is None:
                fallback_creds = creds
        except Exception as exc:
            print(f"Error parsing AWS login cache {json_file}: {exc}", flush=True)
    return fallback_creds


def get_aws_credentials() -> dict[str, Any]:
    global _cached_creds
    now = time.time()
    if _cached_creds is not None and _cached_creds[3] > now + 30:
        return {
            "aws_access_key_id": _cached_creds[0],
            "aws_secret_access_key": _cached_creds[1],
            "aws_session_token": _cached_creds[2],
        }
    profile = os.environ.get("AWS_PROFILE") or os.environ.get("AWS_DEFAULT_PROFILE")
    session = boto3.session.Session(profile_name=profile) if profile else boto3.session.Session()
    try:
        resolved = session.get_credentials()
        frozen = resolved.get_frozen_credentials() if resolved is not None else None
    except Exception as exc:
        print(f"boto3 credential resolution failed ({exc}); trying login cache", flush=True)
        resolved = None
        frozen = None
    if frozen is None:
        fallback = load_login_session_credentials(profile or "default")
        if fallback is None:
            return {}
        _cached_creds = fallback
        return {
            "aws_access_key_id": fallback[0],
            "aws_secret_access_key": fallback[1],
            "aws_session_token": fallback[2],
        }

    expiry_time = getattr(resolved, "_expiry_time", None)
    expires_at_ts = expiry_time.timestamp() if expiry_time is not None else now + 3600
    _cached_creds = (
        frozen.access_key,
        frozen.secret_key,
        frozen.token,
        expires_at_ts,
    )
    return {
        "aws_access_key_id": frozen.access_key,
        "aws_secret_access_key": frozen.secret_key,
        "aws_session_token": frozen.token,
    }


def get_s3_client():
    """S3 client for browser-facing presigned asset URLs.

    Virtual-hosted, REGIONAL endpoint (bucket.s3.<region>.amazonaws.com). The
    browser reads COG byte ranges with a single-range `Range` header, which is
    CORS-safelisted -- so no preflight is sent, and the regional virtual-hosted
    GET returns 206 + Access-Control-Allow-Origin directly.

    Do NOT use the global path-style endpoint (s3.amazonaws.com/bucket): although
    its OPTIONS preflight returns 200, a GET to it 301-redirects a non-us-east-1
    bucket, and that 301 carries no Access-Control-Allow-Origin -- so the browser
    blocks the read before it ever reaches the ranged GET (the regression this
    docstring previously rationalized).
    """
    global _global_s3_client, _global_s3_client_creds_expiry
    now = time.time()

    with _global_s3_client_lock:
        if _global_s3_client is not None and _global_s3_client_creds_expiry > now + 30:
            return _global_s3_client

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        from botocore.config import Config

        s3_config = Config(signature_version="s3v4", s3={"addressing_style": "virtual"})
        creds = get_aws_credentials()
        _global_s3_client_creds_expiry = _cached_creds[3] if _cached_creds else now + 300.0

        client = boto3.client(
            "s3",
            region_name=region,
            config=s3_config,
            **creds,
        )

        def move_request_payer_to_query(request, **kwargs):
            if "x-amz-request-payer" in request.headers:
                request.params["x-amz-request-payer"] = request.headers["x-amz-request-payer"]
                del request.headers["x-amz-request-payer"]

            if request.method in ("GET", "HEAD"):
                for h in list(request.headers.keys()):
                    if h.lower() == "content-type":
                        del request.headers[h]

        client.meta.events.register_first("before-sign.s3", move_request_payer_to_query)
        _global_s3_client = client
        return client


def get_s3_direct_client():
    """S3 client for direct non-presigned server-side calls."""
    global _global_s3_direct_client, _global_s3_direct_client_creds_expiry
    now = time.time()
    with _global_s3_direct_client_lock:
        if _global_s3_direct_client is not None and _global_s3_direct_client_creds_expiry > now + 30:
            return _global_s3_direct_client

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        from botocore.config import Config

        s3_config = Config(signature_version="s3v4", s3={"addressing_style": "virtual"})
        creds = get_aws_credentials()
        _global_s3_direct_client_creds_expiry = _cached_creds[3] if _cached_creds else now + 3600.0
        _global_s3_direct_client = boto3.client("s3", region_name=region, config=s3_config, **creds)
        return _global_s3_direct_client


def _token_bounded_expires_in() -> int:
    now = time.time()
    token_left = int(_cached_creds[3] - now) if _cached_creds else PRESIGN_EXPIRES
    return max(1, min(PRESIGN_EXPIRES, token_left - 30))


def _get_cached_presigned_href(href: str):
    if PRESIGN_CACHE_TTL <= 0:
        return None
    now = monotonic()
    with _presign_cache_lock:
        cached = _presign_cache.get(href)
        if cached is None:
            return None
        expires_at, signed_href, headers = cached
        if expires_at <= now:
            _presign_cache.pop(href, None)
            return None
        _presign_cache.move_to_end(href)
        return signed_href, headers


def _presigned_remaining(href: str) -> int | None:
    if PRESIGN_CACHE_TTL <= 0:
        return None
    with _presign_cache_lock:
        cached = _presign_cache.get(href)
        if cached is None:
            return None
        return max(0, int(cached[0] - monotonic()))


def _store_cached_presigned_href(href: str, signed_href: str, headers: dict[str, str], ttl: int | None = None):
    eff_ttl = PRESIGN_CACHE_TTL if ttl is None else min(PRESIGN_CACHE_TTL, ttl)
    if eff_ttl <= 0:
        return
    expires_at = monotonic() + eff_ttl
    with _presign_cache_lock:
        _presign_cache[href] = (expires_at, signed_href, headers)
        _presign_cache.move_to_end(href)
        while len(_presign_cache) > PRESIGN_CACHE_MAXSIZE:
            _presign_cache.popitem(last=False)


def validate_signable_s3_href(href: str):
    """Parse an S3 href and restrict signing to registered source buckets."""
    parsed = urlparse(href)
    key = parsed.path.lstrip("/")
    if (
        parsed.scheme != "s3"
        or not parsed.netloc
        or not key
        or parsed.query
        or parsed.fragment
        or "@" in parsed.netloc
        or ":" in parsed.netloc
    ):
        raise HTTPException(status_code=400, detail="href must be an s3://bucket/key URL")

    import descriptors

    if not descriptors.is_source_asset(parsed.netloc, key):
        raise HTTPException(
            status_code=403,
            detail="S3 object is not an allowed collection source asset",
        )
    return parsed, key


def _sign_s3_href_uncached(href: str):
    parsed, key = validate_signable_s3_href(href)
    params: dict[str, Any] = {"Bucket": parsed.netloc, "Key": key}
    if REQUEST_PAYER:
        params["RequestPayer"] = REQUEST_PAYER

    expires_in = _token_bounded_expires_in()
    try:
        signed = get_s3_client().generate_presigned_url(
            "get_object",
            Params=params,
            ExpiresIn=expires_in,
        )
    except CredentialRetrievalError as exc:
        raise HTTPException(
            status_code=503,
            detail="AWS credentials expired; reauthenticate with 'aws login' to resume signed COG access.",
        ) from exc
    except BotoCoreError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Failed to sign COG URL: {exc}",
        ) from exc
    headers: dict[str, str] = {}
    _store_cached_presigned_href(href, signed, headers, ttl=expires_in)
    return signed, headers


def maybe_sign_s3_href(href: str | None, stats: dict[str, float | int] | None = None):
    if not href or not href.startswith("s3://") or not SIGN_ASSET_URLS:
        return href, {}, 0

    cached = _get_cached_presigned_href(href)
    if cached is not None:
        if stats is not None:
            stats["presign_cache_hits"] = int(stats.get("presign_cache_hits", 0)) + 1
        signed, headers = cached
        return signed, headers, (_presigned_remaining(href) or _token_bounded_expires_in())

    started_at = monotonic()
    signed, headers = _sign_s3_href_uncached(href)
    if stats is not None:
        stats["presign_cache_misses"] = int(stats.get("presign_cache_misses", 0)) + 1
        stats["presign_seconds"] = float(stats.get("presign_seconds", 0.0)) + (monotonic() - started_at)
    return signed, headers, (_presigned_remaining(href) or _token_bounded_expires_in())


def prepare_signed_hrefs(features: list[dict[str, Any]], stats: dict[str, float | int] | None = None):
    href_map: dict[str, tuple[str, dict[str, str]]] = {}
    cache_miss_hrefs: list[str] = []

    for feature in features:
        assets = feature.get("assets")
        if not isinstance(assets, dict):
            continue
        image_asset = assets.get("image")
        if not isinstance(image_asset, dict):
            continue
        original_href = image_asset.get("href")
        if not isinstance(original_href, str) or not original_href.startswith("s3://") or not SIGN_ASSET_URLS:
            continue
        if original_href in href_map:
            continue
        cached = _get_cached_presigned_href(original_href)
        if cached is not None:
            href_map[original_href] = cached
            if stats is not None:
                stats["presign_cache_hits"] = int(stats.get("presign_cache_hits", 0)) + 1
        else:
            cache_miss_hrefs.append(original_href)

    if cache_miss_hrefs:
        worker_count = min(PRESIGN_MAX_WORKERS, len(cache_miss_hrefs))
        started_at = monotonic()
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = {executor.submit(_sign_s3_href_uncached, href): href for href in cache_miss_hrefs}
            for future in as_completed(futures):
                href = futures[future]
                href_map[href] = future.result()
        if stats is not None:
            stats["presign_cache_misses"] = int(stats.get("presign_cache_misses", 0)) + len(cache_miss_hrefs)
            stats["presign_seconds"] = float(stats.get("presign_seconds", 0.0)) + (monotonic() - started_at)

    return href_map


def rewrite_feature_assets(feature: dict[str, Any], signed_hrefs: dict[str, tuple[str, dict[str, str]]] | None = None):
    assets = feature.get("assets")
    if not isinstance(assets, dict):
        return feature

    image_asset = assets.get("image")
    if isinstance(image_asset, dict):
        original_href = image_asset.get("href")
        signed_entry = signed_hrefs.get(original_href) if isinstance(original_href, str) and signed_hrefs else None
        if signed_entry is not None:
            signed_href, headers = signed_entry
            image_asset["href"] = signed_href
            image_asset["headers"] = headers
            image_asset["source:href"] = original_href

    assets.pop("metadata", None)
    return feature
