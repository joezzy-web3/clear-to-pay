"""What to do next with a HELD or SEIZED invoice: the facts, who acts, and a checked draft to the supplier.

Run from reader/ (reads the receipt and the order from the contract; no keys needed for that):

  python3 tools/next_step.py 3 --invoice ../demo/INV-2209/invoice.json --delivery ../demo/INV-2209/delivery.json
  python3 tools/next_step.py 3 --invoice ... --delivery ... --no-model     # template only, no AI call
  python3 tools/next_step.py --case case.json                               # offline: receipt, invoice, delivery, order in one file

The draft is never sent. A person reads it and sends it, by the supplier's usual channel.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from ctp_reader import chain, query  # noqa: E402
from ctp_reader import model as M  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("receipt_id", nargs="?", type=int)
    ap.add_argument("--invoice", help="the invoice JSON that was submitted")
    ap.add_argument("--delivery", help="the delivery note JSON that was submitted")
    ap.add_argument("--contract", default=chain.CONTRACT)
    ap.add_argument("--case", help="offline: one JSON file with receipt, invoice, delivery, order")
    ap.add_argument("--no-model", action="store_true", help="use the template; do not call the AI")
    a = ap.parse_args()

    if a.case:
        case = json.loads(Path(a.case).read_text())
        rec, inv, dlv, order = case["receipt"], case["invoice"], case.get("delivery"), case.get("order")
    else:
        if a.receipt_id is None or not a.invoice:
            ap.error("give a receipt id and --invoice (and --delivery), or --case")
        try:
            rec = chain.receipt(a.receipt_id, contract=a.contract)
        except chain.ChainError as e:
            print(f"[chain]  ERROR: {e}")
            return 1
        if rec is None:
            print(f"[chain]  no receipt {a.receipt_id} on {a.contract}")
            return 1
        inv = json.loads(Path(a.invoice).read_text())
        dlv = json.loads(Path(a.delivery).read_text()) if a.delivery else None
        if inv["invoice_number"] != rec["invoice_number"]:
            print(f"[check]  this receipt is for {rec['invoice_number']}, not {inv['invoice_number']}; stopping")
            return 1
        order = chain.order(rec["order_id"], contract=a.contract)

    print(f"[receipt] #{rec.get('id', a.receipt_id)} {rec['invoice_number']}: {str(rec['verdict']).upper()} {rec.get('reasons')}")
    if str(rec["verdict"]).upper() == "CLEARED":
        print("[next]    nothing to do: it cleared.")
        return 0
    p = query.plan(rec, inv, dlv, order)
    for f in p.facts:
        print(f"[fact]    {f}")
    for b in p.buyer_actions:
        print(f"[buyer]   {b}")
    if p.seized:
        print("[draft]   none: a SEIZED invoice is never answered in its own thread.")
        return 0
    if not p.supplier_asks:
        print("[draft]   none: nothing for the supplier to fix; the steps above are on the buyer's side.")
        return 0
    query.draft(p, inv, use_model=not a.no_model)
    for prob in p.draft_problems:
        print(f"[check]   model draft not used: {prob}")
    if p.evidence:
        sig = (p.evidence.get("signature") or {}).get("signing_address", "-")
        print(f"[tee]     chat {p.evidence.get('chat_id')}, model {p.evidence.get('served_model')}, signed by {sig}, "
              f"${p.evidence.get('usd', 0):.6f}; spent today ${M.spent_today():.4f}")
    print(f"[draft]   by the {p.drafted_by}. Read it before sending; it is not sent automatically.\n")
    print(f"Subject: {p.draft['subject']}\n\n{p.draft['body']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
