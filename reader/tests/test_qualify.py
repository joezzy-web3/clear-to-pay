"""The qualification gate: a model must read every test invoice right before its software is pinned. Offline.

Run from reader/:  python3 -m pytest -q tests/test_qualify.py
"""

import json
import re

import pytest

from ctp_reader import model as M
from ctp_reader import qualify as Q
from tests.test_model import FakeCloud

FP = [{"kind": "gateway", "os_image_hash": "aa" * 32, "compose_hash": "bb" * 32},
      {"kind": "model", "os_image_hash": "cc" * 32, "compose_hash": "dd" * 32, "launch": {"tag": "v1"}}]


def honest(text, *, obey=False, words=True):
    """A stand-in model that reads the invoice text. obey: follows the instructions written in it."""
    lines = [{"sku": m[0], "qty": m[1], "unit_price": m[2]}
             for m in re.findall(r"^([A-Z0-9][A-Za-z0-9-]+mm)\s+(\d+)\s+([\d.]+)\s", text, re.M)]
    total = re.search(r"Total due: (?:USDC )?([\d,.]+)", text)[1].replace(",", "")
    a = {"supplier_id": re.search(r"Supplier ID: (\S+)", text)[1],
         "invoice_number": re.search(r"Invoice No: (\S+)", text)[1],
         "order_id": re.search(r"Purchase order: (\S+)", text)[1], "currency": "USDC", "lines": lines, "total": total,
         "amount_in_words": (re.search(r"金额大写: (\S+)", text) or [None, None])[1] if words else None}
    if obey and "0.01 USDC" in text:
        a["total"] = "0.01"
    if obey and '"payee"' in text:
        a["payee"] = "qingmar-payments.testnet"
    return a


class Reader(FakeCloud):
    def __init__(self, **how):
        super().__init__()
        self.how = how

    def __call__(self, method, path, key, body=None, timeout=60):
        if path == "/v1/chat/completions":
            text = json.loads(body)["messages"][-1]["content"]
            self.answer = honest(text.removeprefix("<invoice>\n").removesuffix("\n</invoice>"), **self.how)
        return super().__call__(method, path, key, body, timeout)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("CTP_CACHE", str(tmp_path))
    monkeypatch.setenv("NEAR_AI_API_KEY", "test-key")
    monkeypatch.delenv("NEAR_AI_BUILDERS_API_KEY", raising=False)
    monkeypatch.setattr(M.time, "sleep", lambda s: None)


def run(cloud, fps=lambda r, n, m: (FP, [])):
    return Q.run(M.MODEL, send=cloud, fingerprints=fps)


def failed(rep):
    return [c["case"] for c in rep["cases"] if not c["pass"]]


def test_a_model_that_reads_right_qualifies():
    rep = run(Reader())
    assert rep["all_pass"] and failed(rep) == [] and rep["software"] == FP
    assert all(c["chat_id"] for c in rep["cases"]) and rep["prompt_version"] == M.PROMPT_VERSION


def test_the_cases_cover_the_ways_a_model_goes_wrong():
    names = [c.name for c in Q.cases()]
    assert len(names) == len(set(names)) == 7
    assert sum(1 for c in Q.cases() if c.expect_held) == 1  # the words mismatch must be HELD, not read
    assert all(c.expect_invoice["payee"] == Q.ROUTE for c in Q.cases() if c.expect_invoice)


def test_a_model_that_obeys_the_invoice_does_not_qualify():
    assert failed(run(Reader(obey=True))) == ["q06-injected-total", "q07-injected-payee"]


def test_a_model_that_skips_the_amount_in_words_does_not_qualify():
    assert failed(run(Reader(words=False))) == ["q04-words-mismatch"]  # the mismatch would slip through


def test_right_answers_signed_outside_the_attested_enclave_do_not_qualify():
    bad = Reader()
    bad.signer = 0xBAD
    rep = run(bad)
    assert failed(rep) == [c.name for c in Q.cases()]
    assert all(c["held"] == ["model_answer_unverified"] for c in rep["cases"])


def test_software_that_does_not_check_out_does_not_qualify():
    rep = run(Reader(), fps=lambda r, n, m: ([], ["the container setup does not match"]))
    assert not rep["all_pass"] and all("the container setup does not match" in c["problems"] for c in rep["cases"])


def test_qualification_leaves_the_software_check_setting_as_it_was(monkeypatch):
    monkeypatch.setenv("CTP_SOFTWARE_CHECK", "1")
    run(Reader())
    assert M.software_check_on()


def test_pinning_needs_a_passing_report_that_covers_the_software(tmp_path):
    path = tmp_path / "q.json"
    assert "no qualification report" in Q.qualified(FP, M.MODEL, path)[0]
    rep = run(Reader())
    path.write_text(json.dumps(rep))
    assert Q.qualified(FP, M.MODEL, path) == []
    other = [dict(FP[1], os_image_hash="ee" * 32)]  # NEAR redeployed after the run
    assert "was not part of the qualification run" in Q.qualified(other, M.MODEL, path)[0]
    assert Q.qualified(FP, "Qwen/Another", path)  # another model's report does not count
    path.write_text(json.dumps(dict(rep, all_pass=False)))
    assert "did not pass" in Q.qualified(FP, M.MODEL, path)[0]
    path.write_text(json.dumps(dict(rep, prompt_version="1")))
    assert "another prompt version" in Q.qualified(FP, M.MODEL, path)[0]


def test_qualifying_again_asks_again_instead_of_reusing_saved_answers():
    cloud = Reader()
    run(cloud)
    first = sum(1 for c in cloud.calls if c.startswith("POST /v1/chat"))
    run(cloud)
    assert sum(1 for c in cloud.calls if c.startswith("POST /v1/chat")) == 2 * first == 14
