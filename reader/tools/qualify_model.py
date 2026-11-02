"""Qualify a model before its software can be pinned: it must read every test invoice right.

Run from reader/ (the key comes from your environment, loaded from .env; it is never printed):

  python3 tools/qualify_model.py --list                         # the cases; no call, no cost
  python3 tools/qualify_model.py                                # the current model (8 calls, under $0.01; needs the hardware check: pip install -r requirements-hardware.txt)
  python3 tools/qualify_model.py --model "Qwen/Some-New-Model"  # a candidate after a deprecation

Writes docs/proof/qualification-<model>.json. Every case must pass; then
`read_invoice.py --pin-software READING` accepts that model's software. Answers are cached,
so running it again costs nothing. Exit code: 0 all passed, 2 a case failed, 1 error.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from ctp_reader import model, qualify  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--model", default=model.MODEL)
    ap.add_argument("--list", action="store_true", help="print the cases and exit; no call")
    ap.add_argument("--out", help="where to save the report (default docs/proof/qualification-<model>.json)")
    a = ap.parse_args()

    if a.list:
        for c in qualify.cases():
            want = "HELD " + ", ".join(c.expect_held) if c.expect_held else "the exact invoice"
            print(f"{c.name:20} {c.what}  ->  {want}")
        return 0

    print(f"[qualify] {a.model}, prompt version {model.PROMPT_VERSION}, {len(qualify.cases())} cases")
    rep = qualify.run(a.model)
    for r in rep["cases"]:
        mark = "pass" if r["pass"] else "FAIL"
        got = "HELD " + ", ".join(r["held"]) if r["held"] else "invoice " + (r["got"] or {}).get("total", "?") + " units"
        print(f"[{mark}]  {r['case']:20} expected {r['expected']}; got {got}  (chat {r['chat_id'] or '-'})")
        for p in r["problems"]:
            print(f"         PROBLEM: {p}")
        if r.get("rejected"):
            print(f"         rejected by the strict schema: {r['rejected']}")
    for fp in rep["software"]:
        print(f"[soft]   {fp['kind']} enclave: OS image {fp['os_image_hash'][:12]}..., containers {fp['compose_hash'][:12]}...")
    out = Path(a.out) if a.out else qualify.report_path(a.model)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rep, indent=2, ensure_ascii=False) + "\n")
    print(f"[saved]  {out}; signed readings in {qualify.evidence_dir(a.model)} (local, not committed)")
    if rep["all_pass"]:
        gaps = qualify.qualified(rep["software"], a.model, out)
        for g in gaps:
            print(f"[check]  PROBLEM: {g}")
        if gaps:
            print("[result] NOT qualified: the saved evidence does not re-check.")
            return 2
        print("[result] QUALIFIED: every case passed. Its software can now be pinned (read_invoice.py --pin-software).")
        return 0
    print("[result] NOT qualified: do not pin this model's software.")
    return 2


if __name__ == "__main__":
    sys.exit(main())
