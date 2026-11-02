"""Which software the enclave ran, and pinning it (a reply on X: "attestation proves the hardware,
not that the pinned model weights were loaded").

The hardware check proves a genuine Intel TDX machine with a genuine NVIDIA GPU signed the answer.
This module checks WHAT that machine was running, from evidence the same Intel quote covers:

  1. The quote's measurement registers (MRTD, RTMR0-2: firmware, kernel, OS image).
  2. RTMR3, replayed from NEAR's event log (dstack): it must equal the quote's RTMR3. The log
     records the OS image hash and the hash of the exact container setup (app compose), which
     must match the report's own copies.
  3. For the model enclave, the compose manager's signed launch log: its own Intel quote (same
     machine, same registers) carries sha256 of the whole log and OUR nonce. From the log we take
     the deployment that launched the pinned model's container: NEAR's config file, its sha256,
     release tag and git commit.

Those fingerprints are pinned in `software-pins.json` (in the repository, so anyone can review
them). An answer from software that is not pinned is HELD until a person pins it on purpose.

Not proven here: the model weights' own hash. They are loaded by NEAR's pinned deployment file
(by its sha256); the weights are only as provable as that file and NEAR's downloader.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

PINS = Path(__file__).resolve().parent.parent / "software-pins.json"
REGS = ("mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3")


def registers(intel_quote: str) -> dict:
    b = bytes.fromhex(intel_quote)[48:]
    off = {"mrtd": 136, "rtmr0": 328, "rtmr1": 376, "rtmr2": 424, "rtmr3": 472}
    return {k: b[o:o + 48].hex() for k, o in off.items()}


def _json(x):
    return json.loads(x) if isinstance(x, str) else (x or {})


def replay_rtmr3(event_log: list) -> str:
    h = b"\0" * 48
    for e in event_log:
        if e.get("imr") != 3:
            continue
        if e.get("digest"):
            d = bytes.fromhex(e["digest"])
        else:
            d = hashlib.sha384(int(e["event_type"]).to_bytes(4, "little") + b":" + e["event"].encode() + b":"
                               + bytes.fromhex(e.get("event_payload", ""))).digest()
        h = hashlib.sha384(h + d).digest()
    return h.hex()


def model_slug(model: str) -> str:
    """Qwen/Qwen3.6-35B-A3B-FP8 -> qwen36-35b-a3b-fp8, as NEAR names its services."""
    return re.sub(r"[^a-z0-9-]", "", model.split("/")[-1].lower().replace(".", ""))


def fingerprint(kind: str, part: dict, nonce: str, model: str) -> tuple[dict, list[str]]:
    """The software fingerprint of one report part, and problems (empty = every link checks)."""
    label = f"{kind} enclave {part.get('signing_address', '?')}"
    problems: list[str] = []
    try:
        regs = registers(part["intel_quote"])
    except (KeyError, ValueError, TypeError):
        return {}, [f"{label}: no readable quote"]
    info = _json(part.get("info"))
    tcb = _json(info.get("tcb_info"))
    log = _json(part.get("event_log")) or []
    if not log or replay_rtmr3(log) != regs["rtmr3"]:
        problems.append(f"{label}: the event log does not replay to the quote's RTMR3")
    events = {e.get("event"): e.get("event_payload", "") for e in log if e.get("imr") == 3}
    compose = tcb.get("app_compose", "")
    compose_hash = hashlib.sha256(compose.encode()).hexdigest() if compose else ""
    if not compose or events.get("compose-hash") != compose_hash or info.get("compose_hash") != compose_hash:
        problems.append(f"{label}: the container setup does not match the hash measured into the quote")
    if events.get("os-image-hash") != info.get("os_image_hash"):
        problems.append(f"{label}: the OS image hash does not match the one measured into the quote")
    fp = {"kind": kind, "app_id": events.get("app-id", ""), "os_image_hash": info.get("os_image_hash", ""),
          "compose_hash": compose_hash, **{k: regs[k] for k in ("mrtd", "rtmr0", "rtmr1", "rtmr2")}}
    if kind == "model":
        launch, more = model_launch(part, nonce, model, regs)
        problems += [f"{label}: {m}" for m in more]
        fp["launch"] = launch
    return fp, problems


def model_launch(part: dict, nonce: str, model: str, regs: dict) -> tuple[dict, list[str]]:
    """From the compose manager's signed log: the deployment that launched the pinned model."""
    cm = _json(part.get("compose_manager_attestation"))
    if not cm:
        return {}, ["no compose-manager launch log"]
    problems = []
    actions = cm.get("actions") or []
    actions_hash = hashlib.sha256(json.dumps(actions, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if actions_hash != cm.get("actions_hash"):
        problems.append("the launch log does not match its signed hash")
    try:
        cm_regs = registers(cm["quote"])
        rd = bytes.fromhex(cm["quote"])[568:632].hex()
    except (KeyError, ValueError, TypeError):
        return {}, problems + ["the launch log has no readable quote"]
    if cm_regs != regs:
        problems.append("the launch log was signed by a different machine")
    if rd != actions_hash + nonce:
        problems.append("the launch log's quote does not hold its hash and our nonce")
    slug = model_slug(model)
    running: dict = {}
    for a in actions:
        for svc in a.get("services") or []:
            if not (svc.startswith("model-") and slug in svc):
                continue
            if a.get("action") == "compose_up":
                running[svc] = {k: a.get(k) for k in ("file", "file_sha256", "tag", "commit", "timestamp")} | {"service": svc}
            elif a.get("action") == "compose_down":
                running.pop(svc, None)
    if not running:
        problems.append(f"the launch log shows no running container for {model}")
        return {}, problems
    latest = max(running.values(), key=lambda r: r["timestamp"] or "")
    return {k: latest[k] for k in ("service", "file", "file_sha256", "tag", "commit")}, problems


def fingerprints(report: dict, nonce: str, model: str) -> tuple[list[dict], list[str]]:
    from .model import report_parts  # noqa: PLC0415
    fps, problems = [], []
    for kind, part in report_parts(report):
        fp, more = fingerprint(kind, part, nonce, model)
        problems += more
        if fp:
            fps.append(fp)
    if not fps:
        problems.append("no software fingerprints in the report")
    return fps, problems


def load_pins(path: Path = PINS) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def unpinned(fps: list[dict], model: str, pins: dict) -> list[dict]:
    known = pins.get(model, [])
    return [fp for fp in fps if fp not in known]


def pin(fps: list[dict], model: str, path: Path = PINS) -> int:
    pins = load_pins(path)
    known = pins.setdefault(model, [])
    added = [fp for fp in fps if fp not in known]
    known.extend(added)
    path.write_text(json.dumps(pins, indent=2, sort_keys=True) + "\n")
    return len(added)
