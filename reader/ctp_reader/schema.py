"""The only shape the AI is allowed to answer in.

The model fills these fields from the visible, cleaned invoice text. Its answer is
validated strictly: unknown fields, missing fields, wrong types or odd characters
mean the answer is REJECTED, never repaired. There is deliberately no payee field:
whatever the document says about where to pay, the payee is always the supplier's
registered route, taken from the contract, never from the AI.

Amounts are decimal strings ("7.80") converted to the token's smallest unit
(USDC: 6 decimals) by exact arithmetic, never floats.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from .normalize import chinese_amount

ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
QTY = re.compile(r"^[1-9][0-9]{0,9}$")
MONEY = re.compile(r"^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$")
MAX_LINES = 50

FIELDS = {"supplier_id", "invoice_number", "order_id", "currency", "lines", "total", "amount_in_words"}
LINE_FIELDS = {"sku", "qty", "unit_price"}


class Rejected(ValueError):
    """The model's answer does not fit the schema. Never repaired."""


@dataclass(frozen=True)
class Line:
    sku: str
    qty: int
    unit_price: Decimal


@dataclass(frozen=True)
class Extraction:
    supplier_id: str
    invoice_number: str
    order_id: str
    currency: str
    lines: tuple[Line, ...]
    total: Decimal
    amount_in_words: str | None


def _id(v, name: str) -> str:
    if not isinstance(v, str) or not ID.match(v):
        raise Rejected(f"{name} must be a plain ASCII identifier")
    return v


def _money(v, name: str) -> Decimal:
    if not isinstance(v, str) or not MONEY.match(v):
        raise Rejected(f"{name} must be a decimal string like \"7.80\"")
    try:
        return Decimal(v)
    except InvalidOperation as e:  # pragma: no cover - regex already guards
        raise Rejected(f"{name} is not a number") from e


def parse(answer: str | bytes) -> Extraction:
    """Validate the model's raw answer. Raises Rejected on anything unexpected."""
    try:
        data = json.loads(answer)
    except (ValueError, TypeError) as e:
        raise Rejected("answer is not JSON") from e
    if not isinstance(data, dict) or set(data) != FIELDS:
        raise Rejected(f"answer must have exactly these fields: {sorted(FIELDS)}")
    lines_in = data["lines"]
    if not isinstance(lines_in, list) or not 1 <= len(lines_in) <= MAX_LINES:
        raise Rejected("lines must be a list of 1 to 50 items")
    lines = []
    for i, ln in enumerate(lines_in):
        if not isinstance(ln, dict) or set(ln) != LINE_FIELDS:
            raise Rejected(f"line {i} must have exactly: {sorted(LINE_FIELDS)}")
        if not isinstance(ln["qty"], str) or not QTY.match(ln["qty"]):
            raise Rejected(f"line {i} qty must be a whole number string")
        lines.append(
            Line(_id(ln["sku"], f"line {i} sku"), int(ln["qty"]), _money(ln["unit_price"], f"line {i} unit_price"))
        )
    words = data["amount_in_words"]
    if words is not None and (not isinstance(words, str) or len(words) > 64):
        raise Rejected("amount_in_words must be null or a short string")
    if data["currency"] not in ("USDC",):
        raise Rejected("currency must be USDC")
    return Extraction(
        supplier_id=_id(data["supplier_id"], "supplier_id"),
        invoice_number=_id(data["invoice_number"], "invoice_number"),
        order_id=_id(data["order_id"], "order_id"),
        currency=data["currency"],
        lines=tuple(lines),
        total=_money(data["total"], "total"),
        amount_in_words=words,
    )


def to_units(value: Decimal, decimals: int = 6) -> int:
    scaled = value * (Decimal(10) ** decimals)
    if scaled != scaled.to_integral_value():
        raise Rejected(f"{value} has more than {decimals} decimals")
    return int(scaled)


def check(e: Extraction) -> list[str]:
    """Checks on the answer itself. Returns reasons to HOLD (empty = fine)."""
    held = []
    if sum(ln.qty * ln.unit_price for ln in e.lines) != e.total:
        held.append("total_mismatch")
    if e.amount_in_words:
        try:
            if chinese_amount(e.amount_in_words) != e.total:
                held.append("amount_in_words_mismatch")
        except (ValueError, KeyError):
            held.append("amount_in_words_unreadable")
    return held


def to_invoice(e: Extraction, *, token: str, payee_route: dict) -> dict:
    """Build the contract's Invoice JSON.

    `token` comes from the purchase order and `payee_route` from the contract's
    supplier record (the route the buyer verified). Neither comes from the AI.
    """
    return {
        "supplier_id": e.supplier_id,
        "invoice_number": e.invoice_number,
        "order_id": e.order_id,
        "token": token,
        "lines": [
            {"sku": ln.sku, "qty": str(ln.qty), "unit_price": str(to_units(ln.unit_price))}
            for ln in e.lines
        ],
        "total": str(to_units(e.total)),
        "payee": dict(payee_route),
    }
