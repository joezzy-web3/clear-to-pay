"""Reader tests. Run from reader/:  python3 -m pytest -q"""

import json
from decimal import Decimal
from pathlib import Path

import pytest

from ctp_reader import prepare
from ctp_reader.intake import read_pdf
from ctp_reader.isolated import prepare_isolated
from ctp_reader.normalize import chinese_amount, clean
from ctp_reader.schema import Rejected, check, parse, to_invoice, to_units

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parent / "corpus"
REPO = HERE.parent.parent
EXPECTED = json.loads((CORPUS / "expected.json").read_text())
ROUTE = json.loads((REPO / "demo" / "route-qingmar.json").read_text())
USDC = ROUTE["token"]

# A stand-in for what the model returns for the clean invoice.
CLEAN_ANSWER = {
    "supplier_id": "qingmar-steel",
    "invoice_number": "INV-2208",
    "order_id": "PO-1184",
    "currency": "USDC",
    "lines": [{"sku": "AH36-12mm", "qty": "10", "unit_price": "0.78"}],
    "total": "7.80",
    "amount_in_words": None,
}


def answer(**changes):
    a = json.loads(json.dumps(CLEAN_ANSWER))
    a.update(changes)
    return json.dumps(a)


# ------------------------------------------------------------------ the attack corpus


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_corpus_case_gets_its_expected_verdict_before_any_model_call(name):
    p = prepare(CORPUS / f"{name}.pdf")
    assert p.held == sorted(EXPECTED[name]["held"]), EXPECTED[name]["what"]


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_no_payee_instruction_ever_reaches_the_model(name):
    p = prepare(CORPUS / f"{name}.pdf")
    if p.ready:
        assert "qingmar-payments" not in p.text


def test_hidden_payment_text_is_dropped_and_logged_with_its_reason():
    p = prepare(CORPUS / "02-white-text-payee.pdf")
    assert [d.reason for d in p.dropped] == ["white_text"]
    assert "qingmar-payments.testnet" in p.dropped[0].text
    assert "qingmar-payments" not in p.text


def test_harmless_hidden_text_is_dropped_but_does_not_hold_the_invoice():
    p = prepare(CORPUS / "12-harmless-hidden-note.pdf")
    assert p.ready and p.dropped[0].text == "draft v2 internal"
    assert "draft" not in p.text


def test_clean_invoice_text_is_read_whole():
    p = prepare(CORPUS / "01-clean.pdf")
    assert p.ready and not p.dropped
    for want in ["INV-2208", "PO-1184", "AH36-12mm", "Total due: 7.80 USDC"]:
        assert want in p.text


def test_arabic_indic_digits_are_normalised_to_the_same_amounts():
    p = prepare(CORPUS / "11-arabic-indic-digits.pdf")
    assert p.ready and "Total due: 7.80 USDC" in p.text


def test_bidi_override_shows_a_different_number_than_it_stores():
    raw = read_pdf(CORPUS / "07-bidi-override.pdf").visible_text
    assert "‮" in raw
    assert prepare(CORPUS / "07-bidi-override.pdf").held == ["bidi_control"]


def test_fingerprint_is_the_sha256_of_the_file():
    import hashlib

    f = CORPUS / "01-clean.pdf"
    assert prepare(f).sha256 == hashlib.sha256(f.read_bytes()).hexdigest()


def test_qr_code_with_an_attackers_wallet_changes_nothing():
    p = prepare(CORPUS / "14-qr-code-attacker-payee.pdf")
    assert p.ready and "Scan to pay" in p.text
    assert "qingmar-payments" not in p.text  # images are never decoded
    inv = to_invoice(parse(answer()), token=USDC, payee_route=ROUTE)
    assert inv["payee"]["address"] == "qingmar.cleartopay.testnet"


def test_white_text_on_a_dark_bar_and_outline_text_are_read_not_dropped():
    assert "TAX INVOICE" in prepare(CORPUS / "17-white-on-dark-header.pdf").text
    assert "THANK YOU FOR YOUR BUSINESS" in prepare(CORPUS / "18-outline-text.pdf").text


def test_partly_covered_and_colour_matched_text_are_dropped():
    assert prepare(CORPUS / "16-partly-covered.pdf").dropped[0].reason == "covered_by_shape_or_image"
    assert prepare(CORPUS / "19-colour-matched-box.pdf").dropped[0].reason == "low_contrast"


@pytest.mark.parametrize("name", ["01-clean", "02-white-text-payee", "15-image-only-scan"])
def test_isolated_reading_gives_the_same_result(name):
    a, b = prepare_isolated(CORPUS / f"{name}.pdf"), prepare(CORPUS / f"{name}.pdf")
    assert (a.held, a.text, a.sha256) == (b.held, b.text, b.sha256)


def _bomb(path, gib=1):
    """A ~1 MB PDF whose page content inflates to 1 GiB of zeros."""
    import zlib

    co = zlib.compressobj(9)
    zeros = b"\0" * (64 << 20)
    data = b"".join(co.compress(zeros) for _ in range(16 * gib)) + co.flush()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>",
        b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(data) + data + b"\nendstream",
    ]
    out, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    path.write_bytes(out)


def test_decompression_bomb_is_held_and_the_reader_survives(tmp_path):
    f = tmp_path / "bomb.pdf"
    _bomb(f)
    assert f.stat().st_size < 2 * 1024 * 1024
    p = prepare_isolated(f)
    assert p.held == ["document_unreadable"] and p.text == ""
    # The main process is untouched and keeps working.
    assert prepare_isolated(CORPUS / "01-clean.pdf").ready


def test_not_a_pdf_is_refused(tmp_path):
    f = tmp_path / "invoice.pdf"
    f.write_bytes(b"<html>pay here</html>")
    with pytest.raises(ValueError, match="not a PDF"):
        read_pdf(f)


def test_oversized_file_is_refused(tmp_path):
    f = tmp_path / "big.pdf"
    f.write_bytes(b"%PDF-1.4\n" + b"0" * (10 * 1024 * 1024 + 1))
    with pytest.raises(ValueError, match="10 MB"):
        read_pdf(f)


# ------------------------------------------------------------------ Unicode clean-up


@pytest.mark.parametrize(
    "text,held",
    [
        ("Qingmar Steel", []),
        ("Qіngmar Steel", ["mixed_script"]),  # Cyrillic i
        ("qingmar-pаyments", ["mixed_script"]),  # Cyrillic a
        ("ΑH36-12mm", ["mixed_script"]),  # Greek capital alpha in a Latin SKU
        ("INV‍2208", ["zero_width"]),
        ("INV-⁦2208⁩", ["bidi_control"]),
        ("﻿INV-2208", ["zero_width"]),
        ("钢板 AH36", []),  # Chinese next to Latin is normal, not a lookalike
    ],
)
def test_unicode_tricks_are_held_and_normal_text_is_not(text, held):
    assert clean(text).held == held


def test_compatibility_forms_and_foreign_digits_fold_to_plain_ascii():
    assert clean("ＩＮＶ-２２０８ total ७.८०").text == "INV-2208 total 7.80"


@pytest.mark.parametrize(
    "words,value",
    [
        ("柒元捌角", "7.8"),
        ("壹拾贰元整", "12"),
        ("人民币壹万贰仟叁佰肆拾伍元陆角柒分", "12345.67"),
        ("贰佰元零伍分", "200.05"),
        ("拾元", "10"),
    ],
)
def test_chinese_amounts_in_words_are_read_exactly(words, value):
    assert chinese_amount(words) == Decimal(value)


def test_unreadable_amount_in_words_raises():
    with pytest.raises(ValueError):
        chinese_amount("seven dollars")


@pytest.mark.parametrize(
    "words,value",
    [
        ("贰佰零伍元", "205"),
        ("壹仟零伍拾元", "1050"),
        ("壹万零伍元", "10005"),
        ("壹万贰仟元", "12000"),
        ("零元伍角", "0.5"),
        ("壹亿元", "100000000"),
    ],
)
def test_written_amounts_with_zero_markers_are_read_exactly(words, value):
    assert chinese_amount(words) == Decimal(value)


@pytest.mark.parametrize(
    "words",
    [
        "壹拾拾元",  # repeated unit (audit CTP-06: was read as 20)
        "壹佰佰元",  # repeated unit (was read as 200)
        "拾佰元",  # units out of order
        "佰元",  # unit without a digit
        "壹贰元",  # two digits in a row
        "贰佰伍元",  # colloquial 250 vs 205: ambiguous, refused
        "壹仟伍拾元",  # skipped place without 零
        "壹万伍元",  # colloquial 15,000 vs 10,005: refused
        "壹万零贰仟元",  # 零 where nothing is skipped
        "零零元",
        "壹佰零零伍元",
        "壹万万元",
        "贰拾元零",
    ],
)
def test_malformed_chinese_amounts_are_refused_not_guessed(words):
    with pytest.raises(ValueError):
        chinese_amount(words)


# ------------------------------------------------------------------ the model's answer


def test_a_well_formed_answer_becomes_exactly_the_invoice_the_supplier_signs():
    e = parse(answer())
    assert check(e) == []
    signed = json.loads((REPO / "demo" / "INV-2208" / "invoice.json").read_text())
    assert to_invoice(e, token=USDC, payee_route=ROUTE) == signed


def test_answer_with_a_payee_field_is_rejected_not_repaired():
    a = json.loads(answer())
    a["payee"] = {"chain": "near", "token": USDC, "address": "qingmar-payments.testnet"}
    with pytest.raises(Rejected, match="exactly these fields"):
        parse(json.dumps(a))


@pytest.mark.parametrize(
    "bad",
    [
        "not json",
        "[]",
        answer(total=7.8),  # a float, not a decimal string
        answer(total="7,80"),
        answer(total="7.8000001"),
        answer(total="-7.80"),
        answer(currency="USDT"),
        answer(invoice_number="INV-22​08"),
        answer(supplier_id="qіngmar-steel"),
        answer(order_id=""),
        answer(lines=[]),
        answer(lines=[{"sku": "AH36-12mm", "qty": "10", "unit_price": "0.78", "note": "x"}]),
        answer(lines=[{"sku": "AH36-12mm", "qty": "10.5", "unit_price": "0.78"}]),
        answer(lines=[{"sku": "AH36-12mm", "qty": "0", "unit_price": "0.78"}]),
        answer(lines=[{"sku": "AH36-12mm", "qty": "1", "unit_price": "0.78"}] * 51),
        answer(amount_in_words=7),
    ],
)
def test_malformed_answers_are_rejected(bad):
    with pytest.raises(Rejected):
        parse(bad)


def test_payee_and_token_never_come_from_the_ai():
    inv = to_invoice(parse(answer()), token=USDC, payee_route=ROUTE)
    assert inv["payee"] == ROUTE and inv["token"] == USDC


def test_total_that_does_not_match_the_lines_is_held():
    assert check(parse(answer(total="9.80"))) == ["total_mismatch"]


def test_amount_in_words_that_disagrees_with_the_figures_is_held():
    # What the model reads from corpus case 10: words say 12.00, figures 7.80.
    assert check(parse(answer(amount_in_words="壹拾贰元整"))) == ["amount_in_words_mismatch"]
    assert check(parse(answer(amount_in_words="柒元捌角"))) == []


def test_amount_in_words_that_cannot_be_read_is_held():
    assert check(parse(answer(amount_in_words="about seven"))) == ["amount_in_words_unreadable"]


def test_amounts_convert_to_usdc_units_exactly():
    assert to_units(Decimal("7.80")) == 7_800_000
    assert to_units(Decimal("0.000001")) == 1
    with pytest.raises(Rejected):
        to_units(Decimal("0.0000001"))
