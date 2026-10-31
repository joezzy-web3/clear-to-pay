"""Read an untrusted PDF in a separate, limited process.

A small PDF can expand into gigabytes when decompressed, nest objects deeply, or
make the parser spin, and a parser bug could in the worst case run code. So the
document is parsed in a child process, and the main process trusts nothing it
says beyond a small, size-capped, strictly checked JSON answer.

What this module enforces (POSIX only; anywhere else the invoice is HELD):

    size              the file is measured before it is read: over 10 MB is HELD
    input             the child gets the document's bytes on stdin, not a path
    memory            512 MB address space            (setrlimit)
    CPU / wall time   10 s / 20 s                     (setrlimit, then killed)
    file size         0 bytes: it cannot write data   (setrlimit; it can still
                      create an empty file, so this is a limit, not a sandbox)
    open files        64
    environment       empty: no API keys, tokens or paths are inherited
    working folder    a fresh empty temporary folder
    network           none on Linux, where `unshare -rn` gives the child its own
                      network namespace with no interfaces; `isolation_level()`
                      reports whether that was available
    output            at most 4 MB, or the invoice is HELD

What it does NOT enforce: the child runs as the same OS user and can read files
that user can read. Production deployments must run the reader as a dedicated
low-privilege user or container with no network and only the runtime mounted.
This is stated, not claimed.

If the child dies, runs out of memory or time, or prints anything unexpected,
the invoice is HELD with reason `document_unreadable`. Nothing is retried in the
main process.
"""

from __future__ import annotations

import functools
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from . import Prepared
from .intake import MAX_BYTES, Dropped

MEMORY_BYTES = 512 * 1024 * 1024
CPU_SECONDS = 10
WALL_SECONDS = 20
OPEN_FILES = 64
MAX_OUTPUT = 4 * 1024 * 1024
WORKER = Path(__file__).resolve().parent / "worker.py"


def _limits():  # runs in the child, before the worker starts
    import resource

    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (OPEN_FILES, OPEN_FILES))


@functools.lru_cache(maxsize=1)
def isolation_level() -> str:
    """'no-network' when the child gets an empty network namespace, 'limits-only' on
    other POSIX systems, 'unsupported' elsewhere (every document is then HELD)."""
    if os.name != "posix":
        return "unsupported"
    exe = shutil.which("unshare")
    if exe and sys.platform.startswith("linux"):
        try:
            ok = subprocess.run([exe, "-rn", "true"], capture_output=True, timeout=5, env={}).returncode == 0
        except (OSError, subprocess.SubprocessError):
            ok = False
        if ok:
            return "no-network"
    return "limits-only"


def _command(args: list[str]) -> list[str]:
    cmd = [sys.executable, "-I", *args]
    if isolation_level() == "no-network":
        cmd = [shutil.which("unshare"), "-rn", *cmd]
    return cmd


def run_child(args: list[str], stdin: bytes) -> tuple[int | None, bytes, str]:
    """Run `python -I <args>` under the limits. Returns (exit code or None, output, problem).
    `problem` is '' when the child finished normally within every limit."""
    if isolation_level() == "unsupported":
        return None, b"", "isolation_unsupported_platform"
    with tempfile.TemporaryDirectory(prefix="ctp-reader-") as cwd:
        try:
            proc = subprocess.Popen(
                _command(args),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                cwd=cwd,
                env={},
                preexec_fn=_limits,
            )
        except (OSError, ValueError, subprocess.SubprocessError):
            return None, b"", "could_not_start_parser"

        out = bytearray()
        too_big = threading.Event()

        def pump():
            while True:
                chunk = proc.stdout.read(65536)
                if not chunk:
                    return
                if len(out) + len(chunk) > MAX_OUTPUT:
                    too_big.set()
                    proc.kill()
                    return
                out.extend(chunk)

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        try:
            proc.stdin.write(stdin)
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass  # the child died early; its exit code tells us
        try:
            code = proc.wait(timeout=WALL_SECONDS)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            reader.join(timeout=5)
            return None, b"", "timeout"
        reader.join(timeout=5)
        if too_big.is_set():
            return None, b"", "output_too_large"
        return code, bytes(out), ""


def _unreadable(sha256: str, why: str) -> Prepared:
    return Prepared(
        sha256=sha256,
        text="",
        held=["document_unreadable"],
        dropped=[Dropped(page=0, reason=why, text="")],
    )


def prepare_isolated(path: str | Path) -> Prepared:
    p = Path(path)
    size = p.stat().st_size
    if size > MAX_BYTES:  # decided before a single byte is read into memory
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return _unreadable(h.hexdigest(), "document_too_large")
    raw = p.read_bytes()[: MAX_BYTES + 1]
    sha256 = hashlib.sha256(raw).hexdigest()
    if len(raw) > MAX_BYTES:  # grew after it was measured
        return _unreadable(sha256, "document_too_large")

    code, out, problem = run_child([str(WORKER)], raw)
    if problem:
        return _unreadable(sha256, problem)
    if code != 0:
        return _unreadable(sha256, f"parser_failed_{code}")
    try:
        d = json.loads(out)
        result = Prepared(
            sha256=str(d["sha256"]),
            text=str(d["text"]),
            held=[str(x) for x in d["held"]],
            dropped=[Dropped(page=int(x["page"]), reason=str(x["reason"]), text=str(x["text"])) for x in d["dropped"]],
            mixed_script_tokens=[str(x) for x in d["mixed_script_tokens"]],
        )
    except (ValueError, KeyError, TypeError):
        return _unreadable(sha256, "bad_worker_output")
    if result.sha256 != sha256:  # the child read something other than what we sent
        return _unreadable(sha256, "bad_worker_output")
    return result
