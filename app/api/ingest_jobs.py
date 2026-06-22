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
):
    command = [sys.executable, str(INGEST_SCRIPT_PATH), "--collection", collection, "--states", state, "--strategy", strategy]
    if year is not None:
        command.extend(["--years", str(year)])
    if limit_per_partition:
        command.extend(["--limit-per-partition", str(limit_per_partition)])
    try:
        append_ingest_log(job_id, f"$ {' '.join(command)}")
        result = subprocess.run(
            command,
            cwd=str(Path(__file__).parent),
            capture_output=True,
            text=True,
            env=os.environ.copy(),
        )
        for line in (result.stdout or "").splitlines():
            append_ingest_log(job_id, line)
        for line in (result.stderr or "").splitlines():
            append_ingest_log(job_id, f"stderr: {line}")
        if result.returncode == 0:
            set_ingest_job(job_id, {"status": "completed", "returncode": result.returncode, "finished": monotonic()})
        else:
            set_ingest_job(
                job_id,
                {
                    "status": "failed",
                    "returncode": result.returncode,
                    "error": f"Ingest command exited with code {result.returncode}.",
                    "finished": monotonic(),
                },
            )
    except Exception as exc:
        set_ingest_job(job_id, {"status": "failed", "error": str(exc), "finished": monotonic()})
