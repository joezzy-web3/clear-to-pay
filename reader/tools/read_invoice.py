"""Read one invoice PDF end to end: clean it, ask the TEE model, check the signature, build the contract invoice.

Run from reader/ (the key comes from your environment, loaded from .env; it is never printed):

  python3 tools/read_invoice.py corpus/01-clean.pdf --dry-run     # show what would be sent; no call, no cost
  python3 tools/read_invoice.py corpus/01-clean.pdf               # real call on NEAR AI Cloud
  python3 tools/read_invoice.py corpus/01-clean.pdf --write-invoice /tmp/invoice.json
  python3 tools/read_invoice.py --verify reading.json             # re-check a saved reading offline

Exit code: 0 ready, 2 HELD, 1 error.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from ctp_reader import model  # noqa: E402
from ctp_reader.isolated import prepare_isolated  # noqa: E402

ROUTE = HERE.parent / "demo" / "route-qingmar.json"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("pdf", nargs="?")
    ap.add_argument("--route", default=str(ROUTE), help="the supplier's registered payout route (JSON)")
    ap.add_argument("--model", default=model.MODEL)
    ap.add_argument("--dry-run", action="store_true", help="print the request; do not call the model")
    ap.add_argument("--write-invoice", help="save the contract invoice JSON here (for ctp-sign)")
    ap.add_argument("--save", default="reading.json", help="save the full signed reading here")
    ap.add_argument("--verify", metavar="READING", help="re-check a saved reading offline and exit")
    a = ap.parse_args()

    if a.verify:
        problems = model.reverify(json.loads(Path(a.verify).read_text()))
        for p in problems:
            print(f"[verify] PROBLEM: {p}")
        print("[verify] signature checks out: signed inside an attested TEE over these exact bytes" if not problems else "[verify] NOT verified")
        return 0 if not problems else 2
    if not a.pdf:
        ap.error("give a PDF, or --verify READING")

    route = json.loads(Path(a.route).read_text())
    p = prepare_isolated(a.pdf)
    print(f"[reader] {Path(a.pdf).name}  sha256 {p.sha256[:16]}...")
    if p.held:
        print(f"[reader] HELD before any model call: {', '.join(p.held)}")
        return 2
    print(f"[reader] clean visible text: {len(p.text)} characters; hidden text dropped: {len(p.dropped)} pieces")
    if a.dry_run:
        print(f"[model]  would send to {model.BASE} model {a.model}:")
        print("         system: " + model.SYSTEM.splitlines()[0] + " ...")
        print("         user:   <invoice> ... </invoice>  (the clean text above, as data)")
        print(f"[model]  spent today: ${model.spent_today():.4f} of ${model.daily_cap():.2f} cap. Nothing sent.")
        return 0

    try:
        r = model.read_invoice(p, token=route["token"], payee_route=route, model=a.model)
    except model.ModelError as e:
        print(f"[model]  ERROR: {e}")
        return 1
    ev = r.evidence
    if ev:
        print(f"[model]  answered: chat {ev.get('chat_id')}, cost ${ev.get('usd', 0):.6f} (cached answers cost nothing)")
        print(f"[model]  served by {ev.get('served_model')} (finish: {ev.get('finish_reason')})")
        sig = ev.get("signature") or {}
        kind = sig.get("signature_kind", "provider_tee")
        where = "gateway enclave" if kind == "gateway" else "model enclave"
        listed = ev.get("gateway_signers") if kind == "gateway" else ev.get("model_signers")
        print(f"[tee]    signed by {sig.get('signing_address', '-')} (the {where})")
        print(f"[tee]    {where} key(s) in the attestation report, fetched with our nonce "
              f"{ev['attestation_nonce'][:12]}...: {', '.join(listed or ['-'])}")
        for prob in ev.get("problems") or []:
            print(f"[tee]    PROBLEM: {prob}")
        if not ev.get("problems"):
            print("[tee]    signature checks out: these exact request and response bytes came from the attested TEE")
        cached = model._cache_file(p.sha256, a.model)
        if cached.exists():
            shutil.copyfile(cached, a.save)
            print(f"[saved]  {a.save} (re-check any time: python3 tools/read_invoice.py --verify {a.save})")
    if r.held:
        if r.evidence.get("rejected"):
            print(f"[model]  answer rejected by the strict schema: {r.evidence['rejected']}")
        print(f"[result] HELD: {', '.join(r.held)}")
        return 2
    print("[result] ready. Contract invoice (payee from the registered route, not from the model):")
    print(json.dumps(r.invoice, indent=2))
    if a.write_invoice:
        Path(a.write_invoice).write_text(json.dumps(r.invoice, indent=2) + "\n")
        print(f"[saved]  {a.write_invoice}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
