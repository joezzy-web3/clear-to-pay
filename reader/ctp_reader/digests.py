"""The contract's fingerprints, recomputed in Python: borsh encoding + sha-256.

Every receipt records `invoice_digest` (the exact invoice plus the document's fingerprint)
and `delivery_digest` (the exact delivery note). Recomputing them from local files proves
the files are the ones the contract judged, not just files with the same invoice number.
Checked against the contract's golden vectors (src/vector_tests.rs).
"""

from __future__ import annotations

import hashlib

INVOICE_DOMAIN = "clear-to-pay/invoice/v1"
DELIVERY_DOMAIN = "clear-to-pay/delivery/v1"


def _s(v: str) -> bytes:
    b = v.encode()
    return len(b).to_bytes(4, "little") + b


def _u64(v) -> bytes:
    return int(v).to_bytes(8, "little")


def _u128(v) -> bytes:
    return int(v).to_bytes(16, "little")


def _vec(items, enc) -> bytes:
    return len(items).to_bytes(4, "little") + b"".join(enc(x) for x in items)


def _route(r: dict) -> bytes:
    return _s(r["chain"]) + _s(r["token"]) + _s(r["address"])


def _invoice(i: dict) -> bytes:
    return (_s(i["supplier_id"]) + _s(i["invoice_number"]) + _s(i["order_id"]) + _s(i["token"])
            + _vec(i["lines"], lambda l: _s(l["sku"]) + _u64(l["qty"]) + _u128(l["unit_price"]))
            + _u128(i["total"]) + _route(i["payee"]))


def _note(n: dict) -> bytes:
    return _s(n["order_id"]) + _s(n["note_id"]) + _vec(n["lines"], lambda l: _s(l["sku"]) + _u64(l["qty"]))


def invoice_digest(contract: str, invoice: dict, document_hash: bytes) -> str:
    if len(document_hash) != 32:
        raise ValueError("document hash must be 32 bytes")
    return hashlib.sha256(_s(INVOICE_DOMAIN) + _s(contract) + _invoice(invoice) + document_hash).hexdigest()


def delivery_digest(contract: str, note: dict) -> str:
    return hashlib.sha256(_s(DELIVERY_DOMAIN) + _s(contract) + _note(note)).hexdigest()
