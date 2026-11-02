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

from ctp_reader import hardware, model, qualify, software  # noqa: E402
from ctp_reader.isolated import prepare_isolated  # noqa: E402

ROUTE = HERE.parent / "demo" / "route-qingmar.json"


def hardware_step(record: dict, path: Path) -> list[str]:
    """Intel and NVIDIA checks. Online the first time; the full evidence (Intel collateral, NVIDIA
    token) is kept in a local side file, <reading>.hardware.json, and re-checked offline after
    that. Only a short summary goes into the reading itself."""
    side = path.with_name(path.stem + ".hardware.json")
    saved = json.loads(side.read_text()) if side.exists() else None
    nonce = record["evidence"]["attestation_nonce"]
    try:
        h = hardware.check(record.get("attestation_report") or {}, nonce, saved=saved)
    except hardware.HardwareError as e:
        print(f"[hw]     {e}")
        return [str(e)]
    how = f"offline, with the evidence saved in {side.name}" if saved else "online, with Intel and NVIDIA"
    for i in h["intel"]:
        adv = f", advisories {', '.join(i['advisory_ids'])}" if i["advisory_ids"] else ""
        print(f"[hw]     Intel TDX quote of the {i['kind']} enclave {i['signing_address']}: {i['status']}{adv}")
    for i in h.get("intel_launch_log", []):
        print(f"[hw]     Intel TDX quote of the model enclave's launch log: {i['status']}")
    for n in h["nvidia"]:
        print(f"[hw]     NVIDIA GPU attestation for {n['signing_address']}: {n['verdict']}")
    for prob in h["problems"]:
        print(f"[hw]     PROBLEM: {prob}")
    if not h["problems"]:
        print(f"[hw]     hardware checks out ({how})")
        if not saved:
            side.write_text(json.dumps(h, indent=1))
            record["hardware_summary"] = {
                "checked_at": h["checked_at"],
                "intel": [{k: i[k] for k in ("kind", "signing_address", "status", "advisory_ids")} for i in h["intel"]],
                "intel_launch_log": [{k: i[k] for k in ("signing_address", "status", "advisory_ids")}
                                     for i in h.get("intel_launch_log", [])],
                "nvidia": [{k: n[k] for k in ("signing_address", "verdict")} for n in h["nvidia"]],
                "how": "Intel TDX quote chain verified with dcap-qvl against Intel PCS collateral; GPU evidence verified by NVIDIA NRAS",
            }
            path.write_text(json.dumps(record, indent=2))
            print(f"[saved]  summary added to {path.name}; full evidence in {side.name} (local, not committed)")
    return h["problems"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("pdf", nargs="?")
    ap.add_argument("--route", default=str(ROUTE), help="the supplier's registered payout route (JSON)")
    ap.add_argument("--model", default=model.MODEL)
    ap.add_argument("--dry-run", action="store_true", help="print the request; do not call the model")
    ap.add_argument("--write-invoice", help="save the contract invoice JSON here (for ctp-sign)")
    ap.add_argument("--save", default="reading.json", help="save the full signed reading here")
    ap.add_argument("--verify", metavar="READING", help="re-check a saved reading offline and exit")
    ap.add_argument("--pin-software", metavar="READING",
                    help="add the software fingerprints of a verified reading to software-pins.json (review, then commit)")
    ap.add_argument("--hardware", action="store_true",
                    help="also check the attestation down to Intel and NVIDIA (needs dcap-qvl and internet the "
                         "first time; the result is saved in the reading and re-checked offline after that)")
    a = ap.parse_args()

    if a.pin_software:
        record = json.loads(Path(a.pin_software).read_text())
        problems = model.reverify(record)
        if problems:
            for p in problems:
                print(f"[pin]    PROBLEM: {p}")
            print("[pin]    not pinned: the reading does not verify")
            return 2
        fps, _ = software.fingerprints(record["attestation_report"], record["evidence"]["attestation_nonce"],
                                       record["evidence"]["model"])
        gaps = qualify.qualified(fps, record["evidence"]["model"])
        if gaps:  # a re-pin needs evidence that this model, on this software, reads invoices right
            for p in gaps:
                print(f"[pin]    PROBLEM: {p}")
            print(f"[pin]    not pinned: run python3 tools/qualify_model.py --model \"{record['evidence']['model']}\" first")
            return 2
        for fp in fps:
            launch = fp.get("launch") or {}
            extra = f", launched by {launch.get('file')} {launch.get('tag')} (sha256 {launch.get('file_sha256', '')[:12]}...)" if launch else ""
            print(f"[pin]    {fp['kind']} enclave: OS image {fp['os_image_hash'][:12]}..., containers {fp['compose_hash'][:12]}...{extra}")
        n = software.pin(fps, record["evidence"]["model"])
        print(f"[pin]    {n} new fingerprint(s) added to {software.PINS.name}. Review the file, then commit it.")
        return 0

    if a.verify:
        record = json.loads(Path(a.verify).read_text())
        problems = model.reverify(record)
        for p in problems:
            print(f"[verify] PROBLEM: {p}")
        print("[verify] signature checks out: signed inside an enclave over these exact bytes; the enclave's "
              "Intel TDX quote holds its address and our nonce" if not problems else "[verify] NOT verified")
        if a.hardware and not problems:
            problems = hardware_step(record, Path(a.verify))
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
            if a.hardware and not ev.get("problems"):
                if hardware_step(json.loads(Path(a.save).read_text()), Path(a.save)):
                    print("[result] HELD: model_hardware_unverified")
                    return 2
    if r.held:
        for fp in r.evidence.get("unpinned_software") or []:
            print(f"[soft]   not pinned: {fp['kind']} enclave, OS image {fp.get('os_image_hash', '')[:12]}..., "
                  f"containers {fp.get('compose_hash', '')[:12]}...")
        if r.evidence.get("unpinned_software"):
            print(f"[soft]   if NEAR changed its software on purpose: python3 tools/read_invoice.py --pin-software {a.save}")
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
