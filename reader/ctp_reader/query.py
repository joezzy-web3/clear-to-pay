"""What to do after a HELD or SEIZED verdict: the facts, who acts, and a draft message.

Code works out every fact from the contract's receipt, the purchase order and the signed
delivery note. The model (the same attested NEAR AI Cloud call as the reader) only words
those facts as a short message to the supplier. Then code checks the draft: it may not add
a number that is not in the facts, and it may not mention an account, an address, a link,
a wallet or bank details. A draft that fails is thrown away and a plain template is used.
The AI writes; it decides nothing, and nothing is sent without a person reading it.

SEIZED is different: the invoice looks like an attack, and the email it arrived with may be
in the attacker's hands. There is no supplier draft. The next step is to contact the
supplier through a channel already on file, never by replying.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from decimal import Decimal

from . import model as M

DECIMALS = 6

# Reasons the supplier can fix with a corrected invoice (SKU, billed, reference, price...).
SUPPLIER_FIXES = {
    "quantity_exceeds_delivery", "quantity_exceeds_order", "price_mismatch", "total_mismatch",
    "line_not_on_order", "duplicate_line", "token_mismatch", "unknown_order", "order_supplier_mismatch",
    "zero_amount", "delivery_order_mismatch",
}
# Reasons only the buyer's side can resolve; the supplier is not asked to do anything.
BUYER_ACTIONS = {
    "delivery_signatures_missing": "The delivery note has not been confirmed by every role the order requires. "
                                   "Ask the missing signer to check the goods and sign the note; then resubmit.",
    "invalid_delivery_signature": "A delivery signature does not verify. Ask the signers to sign the note again with their registered keys.",
    "delivery_signer_role_not_allowed": "A signer's role is not allowed for this order. Get the note signed by the roles the order requires.",
    "duplicate_delivery_signer": "The same signer signed twice. A second, different role must sign.",
    "duplicate_delivery_role": "Two signers share one role. A signer in a different role must sign.",
    "unknown_storekeeper": "A delivery signer is not registered. Use a registered signer, or register this one first.",
    "over_invoice_limit": "The invoice is above the per-invoice limit. Approve a higher limit deliberately, or pay it outside the agent.",
    "over_period_limit": "The supplier's limit for this period is used up. Wait for the next period, or raise the limit deliberately.",
    "limits_not_set": "No spending limits are set, so nothing can clear. Set limits first.",
    "payee_not_yet_payable": "The supplier's address is still in its 72-hour wait. Resubmit after the time shown on the ledger.",
    "unknown_supplier": "This supplier is not registered. Register it (its address then waits 72 hours) before paying.",
    "arithmetic_overflow": "The numbers are impossibly large. Treat the document as suspect.",
}
SEIZED_NEXT = ("Do not reply to the message this invoice came with, and do not use any contact details in it. "
               "Contact the supplier by a phone number or address already on file and ask whether they sent "
               "invoice {number}. Nothing was paid, and this document can never be paid.")

FORBIDDEN = re.compile(
    r"@|https?:|www\.|\.near\b|\.testnet\b|\b0x[0-9a-f]|iban|swift|routing|account\s*(number|no)|bank|wallet|"
    r"pay(ment)?\s*(to|address|details)|new\s*address",
    re.I,
)


@dataclass
class Plan:
    verdict: str
    facts: list[str]
    supplier_asks: list[str]
    buyer_actions: list[str]
    seized: bool
    draft: dict | None = None
    drafted_by: str = "none"  # "model (attested, checked)", "template", "none"
    evidence: dict = field(default_factory=dict)
    draft_problems: list[str] = field(default_factory=list)


def usdc(units: int | str) -> str:
    v = Decimal(int(units)) / (Decimal(10) ** DECIMALS)
    return f"{v:.2f}" if v == v.quantize(Decimal("0.01")) else f"{v.normalize()}"


def plan(receipt: dict, invoice: dict, delivery: dict | None, order: dict | None) -> Plan:
    """Facts and next steps from the receipt (on chain), the submitted invoice and delivery, and the order."""
    verdict = str(receipt["verdict"]).upper()
    reasons = list(receipt.get("reasons") or [])
    number = invoice["invoice_number"]
    if verdict == "SEIZED":
        return Plan(verdict, [f"Invoice {number} was SEIZED: " + ", ".join(reasons) + "."], [],
                    [SEIZED_NEXT.format(number=number)], seized=True)

    facts: list[str] = []
    asks: list[str] = []
    order_lines = {l["sku"]: l for l in (order or {}).get("lines", [])}
    invoiced = dict(zip([l["sku"] for l in (order or {}).get("lines", [])], (order or {}).get("invoiced", [])))
    delivered = {l["sku"]: int(l["qty"]) for l in (delivery or {}).get("lines", [])}
    note = (delivery or {}).get("note_id", "the delivery note")
    for ln in invoice["lines"]:
        sku, qty, price = ln["sku"], int(ln["qty"]), int(ln["unit_price"])
        if "quantity_exceeds_delivery" in reasons and qty > delivered.get(sku, 0):
            facts.append(f"{sku}: invoice {number} bills {qty}; signed delivery note {note} confirms {delivered.get(sku, 0)}.")
            asks.append(f"a corrected invoice for {sku} that bills {delivered.get(sku, 0)}, or the delivery note for the rest")
        if "quantity_exceeds_order" in reasons and sku in order_lines:
            left = int(order_lines[sku]["qty"]) - int(invoiced.get(sku, 0))
            if qty > left:
                facts.append(f"{sku}: invoice {number} bills {qty}; order {invoice['order_id']} has {left} left to invoice.")
                asks.append(f"a corrected invoice for {sku} within the {left} left on the order")
        if "price_mismatch" in reasons and sku in order_lines and int(order_lines[sku]["unit_price"]) != price:
            facts.append(f"{sku}: invoice {number} charges {usdc(price)} USDC per unit; order {invoice['order_id']} "
                         f"agreed {usdc(order_lines[sku]['unit_price'])}.")
            asks.append(f"a corrected invoice for {sku} at the order price of {usdc(order_lines[sku]['unit_price'])}")
        if "line_not_on_order" in reasons and order is not None and sku not in order_lines:
            facts.append(f"{sku} on invoice {number} is not on order {invoice['order_id']}.")
            asks.append(f"the order reference that covers {sku}, or an invoice without it")
    if "total_mismatch" in reasons:
        lines_sum = sum(int(l["qty"]) * int(l["unit_price"]) for l in invoice["lines"])
        facts.append(f"Invoice {number} states a total of {usdc(invoice['total'])} USDC; its lines add up to {usdc(lines_sum)}.")
        asks.append("a corrected total")
    detailed = {"quantity_exceeds_delivery", "quantity_exceeds_order", "price_mismatch", "total_mismatch", "line_not_on_order"}
    for r in reasons:
        if r in SUPPLIER_FIXES and r not in detailed:
            facts.append(f"Invoice {number}: {r.replace('_', ' ')}.")
            asks.append("a corrected invoice")
    buyer = [BUYER_ACTIONS[r] for r in reasons if r in BUYER_ACTIONS]
    for r in reasons:
        if r not in SUPPLIER_FIXES and r not in BUYER_ACTIONS:
            buyer.append(f"Check reason `{r}` on the ledger before doing anything else.")
    return Plan(verdict, facts, asks, buyer, seized=False)


# ---------------------------------------------------------------- the draft

SYSTEM = (
    "You write short, polite emails from a buyer's accounts-payable team to a supplier.\n"
    "Use ONLY the facts given. Do not add any number, date, name, amount, account, address, link, "
    "phone number, wallet or bank detail, and never ask about or mention payment details.\n"
    "Plain, specific, engineer-like: say what does not match and what to send back. Under 120 words.\n"
    'Answer with ONE JSON object and nothing else: {"subject": str, "body": str}'
)


def template(p: Plan, invoice: dict) -> dict:
    asks = "; ".join(dict.fromkeys(p.supplier_asks))
    body = ("Hello,\n\nWe could not clear invoice {n} yet. What we found:\n- {facts}\n\n"
            "Please send {asks}. Nothing else is needed from you.\n\nThank you,\nAccounts payable").format(
        n=invoice["invoice_number"], facts="\n- ".join(p.facts), asks=asks)
    return {"subject": f"Invoice {invoice['invoice_number']}: correction needed", "body": body}


def check_draft(answer: str, p: Plan, invoice: dict) -> tuple[dict | None, list[str]]:
    """The draft may only restate the facts. Returns (draft, problems)."""
    try:
        d = json.loads(answer)
    except (ValueError, TypeError):
        return None, ["draft is not JSON"]
    if not isinstance(d, dict) or set(d) != {"subject", "body"} or not all(isinstance(v, str) for v in d.values()):
        return None, ["draft must have exactly a subject and a body"]
    text = d["subject"] + "\n" + d["body"]
    problems = []
    if len(text) > 1500:
        problems.append("draft is too long")
    allowed = set(re.findall(r"\d+(?:\.\d+)?", " ".join(p.facts + p.supplier_asks) + " " + invoice["invoice_number"]))
    allowed |= {a.rstrip("0").rstrip(".") for a in allowed if "." in a}
    extra = sorted({n for n in re.findall(r"\d+(?:\.\d+)?", text) if n not in allowed})
    if extra:
        problems.append(f"draft adds numbers not in the facts: {', '.join(extra)}")
    bad = FORBIDDEN.search(text)
    if bad:
        problems.append(f"draft mentions something it must not: {bad.group(0)!r}")
    return (d if not problems else None), problems


def draft(p: Plan, invoice: dict, *, use_model: bool = True, send=M.http, model: str = M.MODEL) -> Plan:
    """Fill p.draft: the attested model's wording if it passes every check, else the template."""
    if p.seized or not p.supplier_asks:
        return p  # no supplier message for SEIZED or buyer-side holds
    if use_model and M.spent_today() < M.daily_cap():
        user = "Facts:\n- " + "\n- ".join(p.facts) + "\n\nAsk the supplier for:\n- " + "\n- ".join(dict.fromkeys(p.supplier_asks)) \
            + f"\n\nInvoice number: {invoice['invoice_number']}"
        sha = hashlib.sha256(user.encode()).hexdigest()
        try:
            r = M.ask("", sha, model=model, key=M.api_key(), send=send, system=SYSTEM, user=user, max_tokens=500)
        except M.ModelError as e:
            p.draft_problems = [f"model unavailable: {e}"]
        else:
            p.evidence = r["evidence"]
            if r["evidence"]["problems"]:
                p.draft_problems = ["model answer unverified: " + "; ".join(r["evidence"]["problems"])]
            elif r["evidence"].get("finish_reason") not in (None, "stop"):
                p.draft_problems = ["model answer cut off"]
            else:
                d, probs = check_draft(r["answer"], p, invoice)
                if d:
                    p.draft, p.drafted_by = d, "model (attested, checked)"
                    return p
                p.draft_problems = probs
    p.draft, p.drafted_by = template(p, invoice), "template"
    return p
