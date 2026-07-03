import time
from pathlib import Path
from threading import Lock

from aws_s3 import get_aws_credentials, get_aws_credentials_expiry, get_s3_client, reset_aws_credentials_cache
from config import COLLECTION_ID, LAKE_ROOT


# Standalone in-process DuckDB connection -- the only query engine. It reads the
# GeoParquet lake directly, so the service works without a database server.
_lake_duckdb_con = None
_lake_duckdb_lock = Lock()
_lake_duckdb_access_key = None
_lake_duckdb_expiry = 0.0


def get_lake_duckdb():
    global _lake_duckdb_con, _lake_duckdb_access_key, _lake_duckdb_expiry
    creds = get_aws_credentials()
    access_key = creds.get("aws_access_key_id")

    if _lake_duckdb_con is not None:
        if access_key != _lake_duckdb_access_key or time.time() > _lake_duckdb_expiry - 30:
            with _lake_duckdb_lock:
                if _lake_duckdb_con is not None:
                    try:
                        _lake_duckdb_con.close()
                    except Exception:
                        pass
                    _lake_duckdb_con = None

    if _lake_duckdb_con is None:
        with _lake_duckdb_lock:
            if _lake_duckdb_con is None:
                import duckdb
                import duckdb_s3

                con = duckdb.connect()
                duckdb_s3.configure(con, LAKE_ROOT, spatial=True)

                _lake_duckdb_con = con
                _lake_duckdb_access_key = access_key
                _lake_duckdb_expiry = get_aws_credentials_expiry() or time.time() + 300
    return _lake_duckdb_con


def _is_expired_token_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "expiredtoken" in msg or "token has expired" in msg or "token included in the request is expired" in msg


def _is_connection_invalidated_error(exc: Exception) -> bool:
    """DuckDB marks the whole connection invalid after a FATAL query error (e.g.
    an out-of-range integer cast in an MVT tile). Every later query then fails
    with 'database has been invalidated ... must be restarted', so we must drop
    and rebuild the connection rather than let one bad query 500 the whole API."""
    msg = str(exc).lower()
    return "has been invalidated" in msg or "must be restarted" in msg


def is_expired_token_error(exc: Exception) -> bool:
    return _is_expired_token_error(exc)


def reset_lake_duckdb():
    global _lake_duckdb_con
    with _lake_duckdb_lock:
        if _lake_duckdb_con is not None:
            try:
                _lake_duckdb_con.close()
            except Exception:
                pass
            _lake_duckdb_con = None


def lake_query(run, *, retried: bool = False):
    """Run `run(cursor)` against the shared lake connection, self-healing once on
    a recoverable connection fault: an expired S3 token (force fresh AWS creds +
    a new connection) or a DuckDB connection invalidated by a prior FATAL query
    (drop and rebuild it). The connection is reset even on the final attempt, so
    a poisoned connection never lingers to 500 the next request."""
    global _lake_duckdb_con
    try:
        return run(get_lake_duckdb().cursor())
    except Exception as exc:
        expired = _is_expired_token_error(exc)
        if not expired and not _is_connection_invalidated_error(exc):
            raise
        reset_lake_duckdb()
        if expired:
            reset_aws_credentials_cache()
        if retried:
            raise
        return lake_query(run, retried=True)


def lake_collections() -> list[str]:
    """Collection ids actually present in the lake, from collection= partition
    dirs. This lists paths only; it does not read parquet data.

    Raises on a listing failure (missing/expired AWS credentials, S3 errors)
    rather than swallowing it: callers must be able to tell a *failed* listing
    apart from a genuinely empty lake. Masking the error as `[]` made a transient
    credential problem look like "only the default collection is ingested",
    silently demoting already-ingested collections (KyFromAbove, NJ) to
    "not ingested" in the viewer. /collections surfaces this as a 503 so the
    client can retry instead."""
    root = str(LAKE_ROOT)
    out: list[str] = []
    if root.startswith("s3://"):
        bucket, _, prefix = root[len("s3://") :].partition("/")
        base = (prefix.rstrip("/") + "/") if prefix else ""
        paginator = get_s3_client().get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket, Prefix=base, Delimiter="/"):
            for cp in page.get("CommonPrefixes", []):
                seg = cp["Prefix"].rstrip("/").rsplit("/", 1)[-1]
                if seg.startswith("collection="):
                    out.append(seg.split("=", 1)[1])
    else:
        for d in Path(root).glob("collection=*"):
            if d.is_dir():
                out.append(d.name.split("=", 1)[1])
    return sorted(set(out))


def lake_years_for_states(states: set[str]) -> dict[str, set[int]]:
    """Ingested years per region from collection=<id>/region=.../year=...
    partition paths for the given regions."""
    out: dict[str, set[int]] = {}
    if not states:
        return out
    root = str(LAKE_ROOT)
    try:
        if root.startswith("s3://"):
            bucket, _, prefix = root[len("s3://") :].partition("/")
            base = (prefix.rstrip("/") + "/") if prefix else ""
            s3 = get_s3_client()
            paginator = s3.get_paginator("list_objects_v2")
            for st in states:
                for page in paginator.paginate(
                    Bucket=bucket,
                    Prefix=f"{base}collection={COLLECTION_ID}/region={st}/",
                    Delimiter="/",
                ):
                    for cp in page.get("CommonPrefixes", []):
                        seg = cp["Prefix"].rstrip("/").rsplit("/", 1)[-1]
                        if seg.startswith("year="):
                            try:
                                out.setdefault(st, set()).add(int(seg.split("=", 1)[1]))
                            except ValueError:
                                pass
        else:
            for st in states:
                sdir = Path(root) / f"collection={COLLECTION_ID}" / f"region={st}"
                if sdir.is_dir():
                    for ydir in sdir.glob("year=*"):
                        try:
                            out.setdefault(st, set()).add(int(ydir.name.split("=", 1)[1]))
                        except ValueError:
                            pass
    except Exception as exc:
        print(f"lake_years_for_states listing failed: {exc}", flush=True)
    return out
