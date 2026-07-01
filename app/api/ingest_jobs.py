import os
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import Any

from config import COLLECTION_ID, INGEST_SCRIPT_PATH


_ingest_jobs: OrderedDict[str, dict[str, Any]] = OrderedDict()
_ingest_jobs_lock = Lock()


def set_ingest_job(job_id: str, payload: dict[str, Any]):
    with _ingest_jobs_lock:
        existing = _ingest_jobs.get(job_id, {})
        existing.update(payload)
        _ingest_jobs[job_id] = existing
        _ingest_jobs.move_to_end(job_id)
        while len(_ingest_jobs) > 20:
            _ingest_jobs.popitem(last=False)


def append_ingest_log(job_id: str, line: str):
    with _ingest_jobs_lock:
        job = _ingest_jobs.setdefault(job_id, {})
        logs = list(job.get("logs", []))
        logs.append(line)
        job["logs"] = logs[-200:]
        _ingest_jobs[job_id] = job


def get_ingest_job(job_id: str):
    with _ingest_jobs_lock:
        return _ingest_jobs.get(job_id)


def run_ingest_job(
    job_id: str,
    state: str,
    year: int | None,
    strategy: str,
    limit_per_partition: int | None = None,
    collection: str = COLLECTION_ID,
    source_bucket: str | None = None,
    source_prefix: str | None = None,
    source_access: str | None = None,
    max_workers: int | None = None,
    source_access_key_id: str | None = None,
    source_secret_access_key: str | None = None,
):
    command = [sys.executable, str(INGEST_SCRIPT_PATH), "--collection", collection, "--states", state, "--strategy", strategy]
    if year is not None:
        command.extend(["--years", str(year)])
    if limit_per_partition:
        command.extend(["--limit-per-partition", str(limit_per_partition)])
    if source_bucket:
        command.extend(["--source-bucket", source_bucket])
    if source_prefix:
        command.extend(["--source-prefix", source_prefix])
    if source_access:
        command.extend(["--source-access", source_access])
    if max_workers:
        command.extend(["--max-workers", str(max_workers)])
    if source_access_key_id:
        command.extend(["--source-access-key-id", source_access_key_id])
    if source_secret_access_key:
        command.extend(["--source-secret-access-key", source_secret_access_key])
    try:
        append_ingest_log(job_id, f"$ {' '.join(command)}")
        process = subprocess.Popen(
            command,
            cwd=str(Path(__file__).parent),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=os.environ.copy(),
        )
        while True:
            line = process.stdout.readline()
            if not line and process.poll() is not None:
                break
            if line:
                append_ingest_log(job_id, line.strip())

        returncode = process.wait()
        if returncode == 0:
            set_ingest_job(job_id, {"status": "completed", "returncode": returncode, "finished": monotonic()})
        else:
            set_ingest_job(
                job_id,
                {
                    "status": "failed",
                    "returncode": returncode,
                    "error": f"Ingest command exited with code {returncode}.",
                    "finished": monotonic(),
                },
            )
    except Exception as exc:
        set_ingest_job(job_id, {"status": "failed", "error": str(exc), "finished": monotonic()})
