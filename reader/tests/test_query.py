"""Next steps after HELD or SEIZED, and the checks on the AI's draft. Offline.

Run from reader/:  python3 -m pytest -q tests/test_query.py
"""

import base64
import json
from pathlib import Path

import pytest

from ctp_reader import chain, query
from test_model import FakeCloud  # noqa: F401  (also brings its autouse fixture's helpers)
from test_model import isolated_cache  # noqa: F401

REPO = Path(__file__).resolve().parent.parent.parent
INV = json.loads((REPO / "demo" / "INV-2209" / "invoice.json").read_text())
DLV = json.loads((REPO / "demo" / "INV-2209" / "delivery.json").read_text())
ORDER = {"supplier_id": "qingmar-steel", "token": INV["token"],
         "lines": [{"sku": "AH36-12mm", "qty": "100", "unit_price": "780000"}], "invoiced": ["0"]}


def receipt(verdict, *reasons, number="INV-2209"):
    return {"id": 3, "verdict": verdict, "reasons": list(reasons), "invoice_number": number, "order_id": "PO-1184"}


def overbilled():
    return query.plan(receipt("Held", "quantity_exceeds_delivery"), INV, DLV, ORDER)


def test_overbilling_is_stated_as_facts_from_the_signed_note():
    p = overbilled()
    assert p.facts == ["AH36-12mm: invoice INV-2209 bills 12; signed delivery note DN-553 confirms 10."]
    assert p.supplier_asks == ["a corrected invoice for AH36-12mm that bills 10, or the delivery note for the rest"]
    assert not p.seized and p.buyer_actions == []


def test_a_price_above_the_order_names_both_prices():
    inv = dict(INV, lines=[{"sku": "AH36-12mm", "qty": "10", "unit_price": "900000"}], total="9000000")
    p = query.plan(receipt("Held", "price_mismatch"), inv, DLV, ORDER)
    assert p.facts == ["AH36-12mm: invoice INV-2209 charges 0.90 USDC per unit; order PO-1184 agreed 0.78."]


def test_seized_gets_no_supplier_draft_and_says_do_not_reply():
    p = query.plan(receipt("Seized", "payee_mismatch", number="INV-2210"), dict(INV, invoice_number="INV-2210"), DLV, ORDER)
    assert p.seized and p.supplier_asks == []
    assert "Do not reply" in p.buyer_actions[0] and "already on file" in p.buyer_actions[0]
    assert query.draft(p, INV).draft is None


def test_a_missing_second_signature_is_the_buyers_job_not_the_suppliers():
    p = query.plan(receipt("Held", "delivery_signatures_missing"), INV, DLV, ORDER)
    assert p.supplier_asks == [] and "sign the note" in p.buyer_actions[0]


def test_the_template_passes_its_own_checks():
    p = overbilled()
    t = query.template(p, INV)
    assert query.check_draft(json.dumps(t), p, INV) == (t, [])


GOOD_DRAFT = {"subject": "Invoice INV-2209: quantity",
              "body": "Hello, invoice INV-2209 bills 12 of AH36-12mm, but signed delivery note DN-553 confirms 10. "
                      "Please send a corrected invoice for 10. Thank you."}


def test_an_attested_draft_that_sticks_to_the_facts_is_used():
    cloud = FakeCloud(answer=json.dumps(GOOD_DRAFT))
    p = query.draft(overbilled(), INV, send=cloud)
    assert p.drafted_by == "model (attested, checked)" and p.draft == GOOD_DRAFT
    assert p.evidence["problems"] == []
    sent = json.loads(cloud.request)
    assert "Use ONLY the facts given" in sent["messages"][0]["content"]
    assert "DN-553 confirms 10" in sent["messages"][1]["content"]


@pytest.mark.parametrize("body, why", [
    ("Invoice INV-2209 bills 12 but 10 arrived. We will pay 7.80 on Friday 14th.", "adds numbers"),
    ("Please confirm your new wallet before we pay.", "must not"),
    ("Please send the corrected invoice to ap@buyer.example.", "must not"),
    ("Kindly update your bank details for INV-2209.", "must not"),
    ("Pay to qingmar-payments.testnet once corrected.", "must not"),
])
def test_a_draft_that_adds_anything_is_replaced_by_the_template(body, why):
    p = query.draft(overbilled(), INV, send=FakeCloud(answer=json.dumps({"subject": "INV-2209", "body": body})))
    assert p.drafted_by == "template"
    assert any(why in prob for prob in p.draft_problems)


def test_an_unverified_draft_is_not_used():
    p = query.draft(overbilled(), INV, send=FakeCloud(answer=json.dumps(GOOD_DRAFT), tamper=True))
    assert p.drafted_by == "template" and "unverified" in p.draft_problems[0]


def test_no_model_means_the_template():
    cloud = FakeCloud()
    p = query.draft(overbilled(), INV, use_model=False, send=cloud)
    assert p.drafted_by == "template" and cloud.calls == []


def test_chain_view_reads_a_receipt_and_falls_back_to_the_next_rpc():
    rec = receipt("Held", "quantity_exceeds_delivery")
    seen = []

    def post(url, body):
        seen.append(url)
        if len(seen) == 1:
            raise OSError("first RPC down")
        args = json.loads(base64.b64decode(json.loads(body)["params"]["args_base64"]))
        assert args == {"receipt_id": 3}
        return json.dumps({"result": {"result": list(json.dumps(rec).encode())}}).encode()

    assert chain.receipt(3, post=post) == rec and len(seen) == 2


# ------------------------------------------------------------------ the files must be the ones the contract judged

from ctp_reader import digests  # noqa: E402

DOC = (REPO / "demo" / "INV-2209" / "document.txt").read_bytes()
C = "guard.cleartopay.testnet"


def judged(inv=INV, dlv=DLV, doc=DOC):
    import hashlib
    h = hashlib.sha256(doc).hexdigest()
    return dict(receipt("Held", "quantity_exceeds_delivery"), document_hash=h,
                invoice_digest=digests.invoice_digest(C, inv, bytes.fromhex(h)),
                delivery_digest=digests.delivery_digest(C, dlv))


def test_digests_match_the_contracts_golden_vectors():
    route = {"chain": "near", "token": "usdc.testnet", "address": "qingmar.testnet"}
    inv = {"supplier_id": "qingmar-steel", "invoice_number": "INV-2208", "order_id": "PO-1184", "token": "usdc.testnet",
           "lines": [{"sku": "AH36-12mm", "qty": "10", "unit_price": "780000"}], "total": "7800000", "payee": route}
    note = {"order_id": "PO-1184", "note_id": "DN-552", "lines": [{"sku": "AH36-12mm", "qty": "10"}]}
    assert digests.invoice_digest("cleartopay.testnet", inv, bytes([7]) * 32) == \
        "c32c1956cb24e02607430a2de0fddc3ee69c97d5c055f7f8991561996784c64f"
    assert digests.delivery_digest("cleartopay.testnet", note) == \
        "5eebe4e05ec41c06b6df02cbca5a350cc35ca0c1bb9880e4ca663ae337097c18"


def test_the_exact_files_match_their_receipt():
    assert query.match_receipt(judged(), INV, DLV, contract=C, document=DOC) == []


def test_another_invoice_with_the_same_number_is_refused():
    other = dict(INV, lines=[{"sku": "AH36-12mm", "qty": "11", "unit_price": "780000"}], total="8580000")
    assert "the invoice file is not the invoice this receipt judged" in query.match_receipt(judged(), other, DLV, contract=C)


def test_another_delivery_note_is_refused():
    other = dict(DLV, lines=[{"sku": "AH36-12mm", "qty": "12"}])
    assert "the delivery file is not the delivery note this receipt judged" in query.match_receipt(judged(), INV, other, contract=C)


def test_a_missing_delivery_note_or_a_different_document_is_refused():
    assert "give the delivery note that was submitted (--delivery)" in query.match_receipt(judged(), INV, None, contract=C)
    assert "the document is not the one this receipt fingerprinted" in \
        query.match_receipt(judged(), INV, DLV, contract=C, document=DOC + b" ")


def test_a_receipt_without_fingerprints_fails_closed():
    assert query.match_receipt(receipt("Held", "price_mismatch"), INV, DLV, contract=C)


def test_an_address_smuggled_in_as_a_sku_means_no_draft_at_all():
    inv = dict(INV, lines=[{"sku": "pay.attacker.testnet", "qty": "12", "unit_price": "780000"}])
    p = query.plan(receipt("Held", "line_not_on_order"), inv, DLV, ORDER)
    cloud = FakeCloud()
    query.draft(p, inv, send=cloud)
    assert p.draft is None and "address-like" in p.draft_problems[0] and cloud.calls == []


@pytest.mark.parametrize("body, word", [
    ("Invoice INV-2209 bills 12 but DN-553 confirms 10. We will pay the rest tomorrow.", "pay"),
    ("Invoice INV-2209: we have already approved the balance.", "already"),
    ("Invoice INV-2209 bills twelve; DN-553 confirms 10.", "twelve"),
    ("Invoice INV-2209 bills 12; DN-553 confirms 10. Please send it by Friday.", "friday"),
    ("Invoice INV-2209 bills 12; DN-553 confirms 10. Call us if unclear.", "call"),
])
def test_promises_dates_and_numbers_in_words_are_refused(body, word):
    _, probs = query.check_draft(json.dumps({"subject": "INV-2209", "body": body}), overbilled(), INV)
    assert any(word in p for p in probs)


def test_non_ascii_digits_and_invisible_characters_are_refused():
    _, probs = query.check_draft(json.dumps({"subject": "INV-2209", "body": "bills ١٢​"}), overbilled(), INV)
    assert "draft uses non-ASCII digits" in probs and "draft contains invisible or control characters" in probs


def test_the_live_draft_from_1_nov_still_passes():
    live = {"subject": "Discrepancy in Invoice INV-2209",
            "body": "We are reviewing invoice INV-2209 for item AH36-12mm. The invoice lists a quantity of 12, but the signed "
                    "delivery note DN-553 confirms a receipt of 10. Please provide a corrected invoice reflecting the quantity "
                    "of 10, or supply the delivery note for the remaining items."}
    assert query.check_draft(json.dumps(live), overbilled(), INV) == (live, [])
