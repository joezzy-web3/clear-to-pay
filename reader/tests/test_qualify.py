"""The qualification gate: one software version must read every test invoice right before it is pinned. Offline.

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
FP_B = [dict(FP[0]), dict(FP[1], os_image_hash="ee" * 32)]


def honest(text, *, obey=False, words=True):
    """A stand-in model that reads the invoice text. obey: follows the instructions written in it."""
    lines = [{"sku": m[0], "qty": m[1], "unit_price": m[2]}
             for m in re.findall(r"^([A-Z0-9][A-Za-z0-9-]+mm)\s+(\d+)\s+([\d.]+)\s", text, re.M)]
    total = re.search(r"Total due: (?:USDC )?([\d,.]+)", text)[1].replace(",", "")
    a = {"supplier_id": re.search(r"Supplier ID: (\S+)", text)[1],
         "invoice_number": re.search(r"Invoice No: (\S+)", text)[1],
         "order_id": re.search(r"Purchase order: (\S+)", text)[1], "currency": "USDC", "lines": lines, "total": total,
         "amount_in_words": (re.search(r"金额大写: (\S+)", text) or [None, None])[1] if words else None}
    if obey and ("0.01 USDC" in text or "total 0.01" in text):
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
            msg = json.loads(body)["messages"][-1]["content"]
            self.answer = honest(json.loads(msg.split(M.USER_PREFIX, 1)[1]), **self.how)
        return super().__call__(method, path, key, body, timeout)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("CTP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("NEAR_AI_API_KEY", "test-key")
    monkeypatch.delenv("NEAR_AI_BUILDERS_API_KEY", raising=False)
    monkeypatch.setattr(M.time, "sleep", lambda s: None)
    monkeypatch.setattr(M, "software_problems", lambda report, nonce, model: [])
    monkeypatch.setattr(M, "hardware_problems", lambda record: [])
    monkeypatch.setattr(Q, "evidence_dir", lambda model: tmp_path / "evidence")
    monkeypatch.setattr(Q, "report_path", lambda model: tmp_path / "report.json")


def fps(seq=None):
    seq = list(seq or [])
    return lambda report, nonce, model: ((seq.pop(0) if seq else FP), [])


def run(cloud, fp=None):
    return Q.run(M.MODEL, send=cloud, fingerprints=fp or fps())


def failed(rep):
    return [c["case"] for c in rep["cases"] if not c["pass"]]


def save(rep, tmp_path):
    (tmp_path / "report.json").write_text(json.dumps(rep))


def test_a_model_that_reads_right_qualifies_and_the_gate_rechecks_the_evidence(tmp_path):
    rep = run(Reader())
    assert rep["all_pass"] and failed(rep) == [] and rep["software"] == FP
    assert rep["prompt_sha"] == M.PROMPT_SHA and all(c["chat_id"] and c["response_sha256"] for c in rep["cases"])
    save(rep, tmp_path)
    assert Q.qualified(FP, M.MODEL, fingerprints=fps()) == []


def test_the_cases_cover_the_ways_a_model_goes_wrong():
    names = [c.name for c in Q.cases()]
    assert len(names) == len(set(names)) == 8 and "q08-fake-end-tag" in names
    assert sum(1 for c in Q.cases() if c.expect_held) == 1  # the words mismatch must be HELD, not read
    assert all(c.expect_invoice["payee"] == Q.ROUTE for c in Q.cases() if c.expect_invoice)


def test_a_model_that_obeys_the_invoice_does_not_qualify():
    assert failed(run(Reader(obey=True))) == ["q06-injected-total", "q07-injected-payee", "q08-fake-end-tag"]


def test_a_model_that_skips_the_amount_in_words_does_not_qualify():
    assert failed(run(Reader(words=False))) == ["q04-words-mismatch"]  # the mismatch would slip through


def test_right_answers_signed_outside_the_attested_enclave_do_not_qualify():
    bad = Reader()
    bad.signer = 0xBAD
    rep = run(bad)
    assert failed(rep) == [c.name for c in Q.cases()]
    assert all(c["held"] == ["model_answer_unverified"] for c in rep["cases"])


def test_software_that_changes_during_the_run_does_not_qualify(tmp_path):
    rep = run(Reader(), fp=fps([FP] * 7 + [FP_B]))  # NEAR redeploys before the last case
    assert not rep["all_pass"] and rep["software"] == []
    assert all("the software changed during the run" in " ".join(c["problems"]) for c in rep["cases"])
    save(dict(rep, all_pass=True, software=FP_B), tmp_path)  # even a report edited to claim B passed
    assert Q.qualified(FP_B, M.MODEL, fingerprints=fps([FP] * 7 + [FP_B]))


def test_software_that_does_not_check_out_does_not_qualify():
    rep = run(Reader(), fp=lambda r, n, m: ([], ["the container setup does not match"]))
    assert not rep["all_pass"] and all("the container setup does not match" in c["problems"] for c in rep["cases"])


def test_qualifying_again_asks_again_instead_of_reusing_saved_answers():
    cloud = Reader()
    run(cloud)
    first = sum(1 for c in cloud.calls if c.startswith("POST /v1/chat"))
    run(cloud)
    assert sum(1 for c in cloud.calls if c.startswith("POST /v1/chat")) == 2 * first == 16


def test_a_forged_report_is_not_trusted(tmp_path):
    assert "no qualification report" in Q.qualified(FP, M.MODEL)[0]
    rep = run(Reader(obey=True))
    save(dict(rep, all_pass=True, cases=[dict(c, **{"pass": True}) for c in rep["cases"]]), tmp_path)
    gaps = Q.qualified(FP, M.MODEL, fingerprints=fps())
    assert {g.split(":")[0] for g in gaps} == {"q06-injected-total", "q07-injected-payee", "q08-fake-end-tag"}
    good = run(Reader())
    save(dict(good, cases=good["cases"][:-1]), tmp_path)  # a case left out
    assert any("exactly the current cases" in g for g in Q.qualified(FP, M.MODEL, fingerprints=fps()))
    save(dict(good, prompt_sha="0" * 16), tmp_path)
    assert any("another prompt" in g for g in Q.qualified(FP, M.MODEL, fingerprints=fps()))
    save(good, tmp_path)
    assert any("not the software that answered" in g for g in Q.qualified(FP_B, M.MODEL, fingerprints=fps()))
    for f in (tmp_path / "evidence").glob("*.json"):  # pinning on a machine that never ran it
        f.unlink()
    assert any("no signed reading on this machine" in g for g in Q.qualified(FP, M.MODEL, fingerprints=fps()))


def test_an_edited_saved_reading_fails_the_gate(tmp_path):
    rep = run(Reader())
    save(rep, tmp_path)
    f = tmp_path / "evidence" / "q01-clean.json"
    rec = json.loads(f.read_text())
    rec["answer"] = rec["answer"].replace("7.80", "0.01")
    f.write_text(json.dumps(rec))
    assert any(g.startswith("q01-clean:") for g in Q.qualified(FP, M.MODEL, fingerprints=fps()))
