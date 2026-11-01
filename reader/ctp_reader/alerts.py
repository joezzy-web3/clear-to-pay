"""Alerts: watch the contract and tell the right person, on Telegram, when something happens.

Read-only. It polls the contract's public views (no keys), compares with what it saw last
time, and sends one message per change. The point is the 72-hour wait on address changes:
if anyone proposes a new payout address, the buyer and the supplier hear about it at once,
with the time it could first be paid, while there is still time to cancel.

Standard library only. The Telegram bot token is read from the environment, never printed.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from . import chain
from .query import BUYER_ACTIONS, SEIZED_NEXT, usdc

LEDGER = "https://joezzy-web3.github.io/clear-to-pay/ledger/"
LAGOS = _dt.timezone(_dt.timedelta(hours=1), "Lagos")
FINAL = {"Settled", "Cancelled"}


@dataclass
class Alert:
    level: str  # "ALARM" or "INFO"
    text: str


def when(ns: int | str) -> str:
    t = _dt.datetime.fromtimestamp(int(ns) / 1e9, _dt.timezone.utc)
    return f"{t:%a %d %b %H:%M} UTC ({t.astimezone(LAGOS):%H:%M} Lagos)"


def snapshot(view, *, suppliers: list[str], token: str, known: dict | None = None) -> dict:
    """What the contract says now. Receipts already seen are not fetched again.

    Suppliers come from the contract's own list (`get_supplier_ids`, v2.3) plus any given
    by hand, so a supplier added later is watched without anyone remembering to add it."""
    known = known or {}
    try:
        listed = view("get_supplier_ids", {}) or []
    except Exception:  # older contract without the list: the hand-kept list only
        listed = []
    suppliers = list(dict.fromkeys([*suppliers, *listed]))
    receipts = dict(known.get("receipts", {}))
    count = int(view("receipt_count", {}))
    for i in range(len(receipts), count):
        r = view("get_receipt", {"receipt_id": i})
        if r:
            receipts[str(i)] = {k: r.get(k) for k in ("verdict", "reasons", "invoice_number", "supplier_id", "amount", "order_id")}
    payments = dict(known.get("payments", {}))
    for i, r in receipts.items():
        if r["verdict"] == "Cleared" and payments.get(i, {}).get("status") not in FINAL:
            p = view("get_payment", {"receipt_id": int(i)})
            if p:
                payments[i] = {k: p.get(k) for k in ("status", "amount", "attempt")} | {"to": (p.get("recipient") or {}).get("address")}
    sup = {}
    for s in suppliers:
        v = view("get_supplier", {"supplier_id": s})
        if v:
            sup[s] = {"route": v["route_on_file"]["address"], "payable_from": str(v["route_payable_from"]),
                      "nonce": str(v.get("last_nonce", "0")),
                      "pending": v.get("pending") and {"route": v["pending"]["route"]["address"],
                                                       "proposed_at": str(v["pending"]["proposed_at"]),
                                                       "approved": bool(v["pending"]["approved"])}}
    signers = {s["key"]: s["role"] for s in view("get_delivery_signers", {}) or []}
    funds = view("get_funds", {"token": token}) or {}
    return {"receipts": receipts, "payments": payments, "suppliers": sup, "signers": signers,
            "funds": {"available": str(funds.get("available", "0")), "reserved": str(funds.get("reserved", "0"))}}


def changes(old: dict, new: dict) -> list[Alert]:
    """One alert per change, in the order a person should read them (alarms first)."""
    out: list[Alert] = []
    # payout address changes: the reason this exists
    for s, now in new["suppliers"].items():
        before = old.get("suppliers", {}).get(s, {})
        p, q = now.get("pending"), before.get("pending")
        if before and int(now.get("nonce", 0)) > int(before.get("nonce", 0)) + (1 if p and p != q else 0):
            # the supplier's signed-change counter moved more than the change we can see:
            # a change was proposed (and maybe cancelled or replaced) between two checks
            out.append(Alert("ALARM", f"Payout address activity for {s} between checks: the signed-change counter went "
                                      f"from {before.get('nonce')} to {now.get('nonce')}. Check the ledger and the supplier's "
                                      f"address now."))
        if not before and old.get("suppliers") is not None and s not in old.get("suppliers", {}):
            out.append(Alert("ALARM", f"New supplier registered: {s}, payout address {now['route']}. "
                                      f"Not expected? It cannot be paid for 72 hours; tell the buyer now."))
        if p and (not q or q["route"] != p["route"] or q["proposed_at"] != p["proposed_at"]):
            eta = int(p["proposed_at"]) + 72 * 3600 * 10**9
            out.append(Alert("ALARM",
                f"Payout address change PROPOSED for {s}: {before.get('route', now['route'])} -> {p['route']}. "
                f"Earliest it could be paid: {when(eta)}, and only if the buyer approves. "
                f"Did not ask for this? Supplier: call the buyer now. Buyer: do not approve; cancel it (cancel_payout_change)."))
        elif p and q and p["approved"] and not q["approved"]:
            eta = int(p["proposed_at"]) + 72 * 3600 * 10**9
            out.append(Alert("ALARM", f"Payout address change APPROVED for {s}: -> {p['route']}. It takes effect {when(eta)}. "
                                      f"Not expected? The buyer can still cancel it until then."))
        elif q and not p:
            if now["route"] == q["route"]:
                out.append(Alert("INFO", f"Payout address for {s} is now {now['route']} (the approved change took effect)."))
            else:
                out.append(Alert("INFO", f"Payout address change for {s} to {q['route']} was cancelled. Address stays {now['route']}."))
        elif before and before.get("route") != now["route"] and not q:
            out.append(Alert("ALARM", f"Payout address for {s} changed: {before['route']} -> {now['route']}."))
    # delivery signers: a stolen or added key is how a false delivery would get in
    for k, role in new["signers"].items():
        if k not in old.get("signers", {}):
            out.append(Alert("ALARM", f"Delivery signer ADDED: role {role}, key {k[:20]}... Not expected? Remove it before any invoice is submitted."))
    for k, role in old.get("signers", {}).items():
        if k not in new["signers"]:
            out.append(Alert("INFO", f"Delivery signer removed: role {role}, key {k[:20]}..."))
    # verdicts
    for i, r in new["receipts"].items():
        if i in old.get("receipts", {}):
            continue
        amt = f"{usdc(r['amount'])} USDC"
        reasons = ", ".join(r["reasons"] or [])
        if r["verdict"] == "Seized":
            out.append(Alert("ALARM", f"SEIZED invoice {r['invoice_number']} from {r['supplier_id']} ({amt}): {reasons}. "
                                      + SEIZED_NEXT.format(number=r["invoice_number"]) + f" {LEDGER}"))
        elif r["verdict"] == "Held":
            steps = [BUYER_ACTIONS[x] for x in r["reasons"] if x in BUYER_ACTIONS]
            more = " " + " ".join(steps) if steps else ""
            fix = [x for x in r["reasons"] if x not in BUYER_ACTIONS]
            sup = f" Supplier to correct: {', '.join(fix)} (draft the query with tools/next_step.py {i})." if fix else ""
            out.append(Alert("INFO", f"HELD invoice {r['invoice_number']} from {r['supplier_id']} ({amt}): {reasons}.{more}{sup} {LEDGER}"))
        else:
            out.append(Alert("INFO", f"CLEARED invoice {r['invoice_number']} from {r['supplier_id']} ({amt}). {LEDGER}"))
    # payments
    for i, p in new["payments"].items():
        before = old.get("payments", {}).get(i, {})
        if before.get("status") == p["status"] and before.get("attempt") == p["attempt"]:
            continue
        inv = new["receipts"].get(i, {}).get("invoice_number", f"receipt {i}")
        amt = f"{usdc(p['amount'])} USDC"
        if p["status"] == "Settled":
            out.append(Alert("INFO", f"PAID: {amt} for {inv} reached {p['to']}."))
        elif p["status"] in ("Failed", "Expired"):
            out.append(Alert("ALARM", f"Payment {p['status'].upper()} for {inv} ({amt}); the money is back in the pool. "
                                      f"The buyer can reauthorise it once, to the current registered address."))
        elif p["status"] == "Submitted":
            out.append(Alert("INFO", f"Payment sent for {inv}: {amt} to {p['to']}."))
    # money in and out of the pool
    a0, a1 = int(old.get("funds", {}).get("available", new["funds"]["available"])), int(new["funds"]["available"])
    r0, r1 = int(old.get("funds", {}).get("reserved", new["funds"]["reserved"])), int(new["funds"]["reserved"])
    total0, total1 = a0 + r0, a1 + r1
    paid_out = sum(int(p["amount"]) for i, p in new["payments"].items()
                   if p["status"] == "Settled" and old.get("payments", {}).get(i, {}).get("status") != "Settled")
    if total1 > total0:
        out.append(Alert("INFO", f"Deposit: pool +{usdc(total1 - total0)} USDC, now {usdc(a1)} available."))
    elif total0 - total1 > paid_out:
        out.append(Alert("ALARM", f"Pool down {usdc(total0 - total1 - paid_out)} USDC not explained by a payment "
                                  f"(a withdrawal by the owner?). Now {usdc(a1)} available."))
    out.sort(key=lambda a: a.level != "ALARM")
    return out


# ---------------------------------------------------------------- delivery


def telegram(text: str, *, post=None) -> None:
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        raise RuntimeError("set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (from .env)")
    data = urllib.parse.urlencode({"chat_id": chat, "text": text, "disable_web_page_preview": "true"}).encode()
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        raw = post(url, data) if post else urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=15).read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Telegram refused the message: HTTP {e.code}") from None  # never echo the URL: it holds the token
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"Telegram unreachable: {getattr(e, 'reason', e)}") from None
    if not json.loads(raw).get("ok"):
        raise RuntimeError("Telegram did not accept the message")


def format_alert(a: Alert, contract: str) -> str:
    head = "ALERT" if a.level == "ALARM" else "Clear to Pay"
    return f"{head} | {contract}\n{a.text}"


def load(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def save(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    tmp.replace(path)


def tick(*, view, suppliers, token, state_path: Path, send, contract: str, replay: bool = False,
         cross_check=None) -> list[Alert]:
    """One poll: fetch, compare, send, then remember. State is saved only after every message went out.

    A state file that exists but cannot be read is never silently replaced: it raises an
    ALERT first. `cross_check(method, args)` returns the same view from several RPC servers;
    if they disagree about suppliers or delivery signers, that is an ALERT too."""
    damaged = state_path.exists() and load(state_path) is None
    old = load(state_path)
    first = old is None
    new = snapshot(view, suppliers=suppliers, token=token, known=None if first else old)
    early: list[Alert] = []
    if damaged:
        early.append(Alert("ALARM", "The alert watcher's memory file was damaged and has been rebuilt. Changes made "
                                    "while it was damaged may not have been announced: check the ledger now."))
    if cross_check:
        for s in new["suppliers"]:
            answers = cross_check("get_supplier", {"supplier_id": s})
            if len({json.dumps(a, sort_keys=True) for a in answers}) > 1:
                early.append(Alert("ALARM", f"RPC servers disagree about supplier {s}'s payout address record. "
                                            f"Check it on NearBlocks before approving or paying anything."))
        answers = cross_check("get_delivery_signers", {})
        if len({json.dumps(sorted(a or [], key=lambda x: x.get("key", "")), sort_keys=True) for a in answers}) > 1:
            early.append(Alert("ALARM", "RPC servers disagree about the delivery signers. Check them on NearBlocks."))
    base = old or new
    if first and replay:  # announce past verdicts and payments, not the setup (signers, addresses, pool)
        base = dict(new, receipts={}, payments={})
    alerts = early + changes(base, new)
    for a in alerts:
        send(format_alert(a, contract))
    save(state_path, new)
    return alerts


def view_for(contract: str):
    return lambda method, args: chain.view(method, args, contract=contract)
