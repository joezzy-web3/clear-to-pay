"""Read an untrusted PDF in a separate, limited process.

A small PDF can expand into gigabytes when decompressed, nest objects deeply, or
make the parser spin. The reader therefore parses every document in a child
process with hard limits (Linux/macOS `setrlimit`):

    memory (address space)   512 MB
    CPU time                 10 s
    wall-clock time          20 s
    files it may write       none (size limit 0)

If the child dies, runs out of memory or time, or prints anything unexpected,
the invoice is HELD with reason `document_unreadable`. Nothing is retried in the
main process. Network isolation is not enforced here; deploy the reader where
the parsing process has no network access (stated, not claimed).
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

from . import Prepared
from .intake import Dropped

MEMORY_BYTES = 512 * 1024 * 1024
CPU_SECONDS = 10
WALL_SECONDS = 20
WORKER = Path(__file__).resolve().parent / "worker.py"


def _limits():  # runs in the child, before Python starts
    import resource

    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def _unreadable(sha256: str, why: str) -> Prepared:
    return Prepared(
        sha256=sha256,
        text="",
        held=["document_unreadable"],
        dropped=[Dropped(page=0, reason=why, text="")],
    )


def prepare_isolated(path: str | Path) -> Prepared:
    raw = Path(path).read_bytes()
    sha256 = hashlib.sha256(raw).hexdigest()
    try:
        r = subprocess.run(
            [sys.executable, "-I", str(WORKER), str(Path(path).resolve())],
            capture_output=True,
            timeout=WALL_SECONDS,
            preexec_fn=_limits,
            stdin=subprocess.DEVNULL,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return _unreadable(sha256, "timeout")
    if r.returncode != 0:
        return _unreadable(sha256, f"parser_failed_{r.returncode}")
    try:
        d = json.loads(r.stdout)
        p = Prepared(
            sha256=d["sha256"],
            text=d["text"],
            held=list(d["held"]),
            dropped=[Dropped(**x) for x in d["dropped"]],
            mixed_script_tokens=list(d["mixed_script_tokens"]),
        )
    except (ValueError, KeyError, TypeError):
        return _unreadable(sha256, "bad_worker_output")
    if p.sha256 != sha256:  # the file changed while it was being read
        return _unreadable(sha256, "file_changed")
    return p
