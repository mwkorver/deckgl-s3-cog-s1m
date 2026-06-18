"""Shared DuckDB setup for the COG STAC read + ingest paths.

One place to (a) load the spatial/httpfs extensions and (b) wire S3 access, so
the read API (app.py) and the ingest jobs (ingest_duckdb.py via ingest_manifest)
behave identically.

Extension loading: on Lambda the extension binaries are baked into the layer at
/opt (version- and arch-matched) and LOADed by path -- no INSTALL, so no
download, no writable $HOME, no network egress on cold start. Locally / in
docker there is no such dir, so we fall back to INSTALL (autodownload).

S3 access: only configured when a path is actually s3:// (or S3_COG_DUCKDB_S3=1).
We create an httpfs secret from the ambient credential chain (Lambda execution
role on Lambda; env/profile creds in docker) and enable requester-pays.

  requester-pays note: SET s3_requester_pays=true is required for *non-owner*
  consumers of the public cog-stac-catalog bucket -- without the header their
  reads get 403. For the bucket owner it is a harmless no-op (the owner is
  exempt from sending the header, though still bears any cross-region egress).
"""

import os


def _extension_dir() -> str | None:
    ext_dir = os.environ.get("DUCKDB_EXT_DIR", "/opt/duckdb_extensions")
    return ext_dir if os.path.isdir(ext_dir) else None


def load_extensions(con, *, spatial: bool = True, httpfs: bool = False) -> None:
    """Load spatial and/or httpfs, by path from the baked layer if present."""
    ext_dir = _extension_dir()
    wanted = ([("spatial", spatial)] if spatial else []) + ([("httpfs", httpfs)] if httpfs else [])
    for name, want in wanted:
        if not want:
            continue
        if ext_dir:
            con.execute(f"LOAD '{ext_dir}/{name}.duckdb_extension';")
        else:
            con.execute(f"INSTALL {name}; LOAD {name};")


def load_login_session_credentials(profile_name: str):
    import os
    import json
    import time
    from pathlib import Path
    from datetime import datetime
    import configparser
    
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
            # correct. Naive parsing over-reports validity by the UTC offset on a
            # UTC-negative host, letting an expired ~15min token slip into a
            # baked DuckDB SECRET.
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


def enable_s3(con) -> None:
    """Wire S3 access: credential_chain secret + requester-pays.

    The credential_chain provider lives in DuckDB's `aws` extension (separate
    from httpfs). Load it by path from the baked layer when present so cold
    start needs no INSTALL (no writable $HOME / network egress on Lambda);
    fall back to autodownload locally / in docker.
    """
    ext_dir = _extension_dir()
    if ext_dir:
        con.execute(f"LOAD '{ext_dir}/aws.duckdb_extension';")
    else:
        con.execute("INSTALL aws; LOAD aws;")
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION", "us-west-2")
    
    # Try to resolve credentials using boto3 to pass them explicitly
    access_key = None
    secret_key = None
    token = None
    try:
        import boto3
        profile = os.environ.get("AWS_PROFILE") or os.environ.get("AWS_DEFAULT_PROFILE")
        
        session = boto3.Session(profile_name=profile) if profile else boto3.Session()
        try:
            credentials = session.get_credentials()
        except Exception as exc:
            # botocore without the [crt] extra raises for `aws login` sessions;
            # fall through to the login-cache parser below instead of bailing.
            print(f"Warning: boto3 get_credentials failed: {exc}", flush=True)
            credentials = None
        if credentials:
            try:
                # Freezing refreshable login-session credentials raises
                # RuntimeError when the cached token has lapsed; fall through
                # to the login-cache parser below instead of bailing.
                frozen = credentials.get_frozen_credentials()
                access_key = frozen.access_key
                secret_key = frozen.secret_key
                token = frozen.token
            except Exception as exc:
                print(f"Warning: freezing credentials failed: {exc}", flush=True)
        
        # Fall back to custom login session credentials parser if no credentials resolved
        if not access_key:
            pname = profile or "default"
            fallback = load_login_session_credentials(pname)
            if fallback:
                access_key, secret_key, token, _ = fallback
    except Exception as e:
        print(f"Warning: failed to get AWS credentials: {e}", flush=True)

    if access_key and secret_key:
        sql = f"""
            CREATE SECRET (
                TYPE s3,
                PROVIDER config,
                KEY_ID '{access_key}',
                SECRET '{secret_key}',
                REGION '{region}'
        """
        if token:
            sql += f",\n                SESSION_TOKEN '{token}'"
        sql += "\n            );"
        con.execute(sql)
    else:
        con.execute(f"CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION '{region}');")

    con.execute("SET s3_requester_pays=true;")


def uses_s3(*paths: str) -> bool:
    if os.environ.get("S3_COG_DUCKDB_S3", "") == "1":
        return True
    return any(str(p).startswith("s3://") for p in paths if p)


def configure(con, *paths: str, spatial: bool = True) -> None:
    """Load the needed extensions and wire S3 if any path is s3://.

    httpfs is only loaded when S3 is in play (local reads don't need it).
    """
    s3 = uses_s3(*paths)
    load_extensions(con, spatial=spatial, httpfs=s3)
    if s3:
        enable_s3(con)
