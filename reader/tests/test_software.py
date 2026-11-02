"""Which software the enclave ran, checked on the real live report, and pinned. Offline.

Run from reader/:  python3 -m pytest -q tests/test_software.py
"""

import copy
import hashlib
import json
from pathlib import Path

import pytest

from ctp_reader import hardware as H
from ctp_reader import software as S

REPO = Path(__file__).resolve().parent.parent.parent
LIVE = REPO / "docs" / "proof" / "reading-INV-2208.json"
pytestmark = pytest.mark.skipif(not LIVE.exists(), reason="live reading not present")


@pytest.fixture
def live():
    r = json.loads(LIVE.read_text())
    return r["attestation_report"], r["evidence"]["attestation_nonce"], r["evidence"]["model"]


def parts(report):
    return report["gateway_attestation"], report["model_attestations"][0]


def test_every_link_checks_on_the_live_report(live):
    report, nonce, model = live
    fps, problems = S.fingerprints(report, nonce, model)
    assert problems == []
    gw, md = fps
    assert gw["kind"] == "gateway" and md["kind"] == "model"
    assert md["launch"]["service"] == "model-sg-qwen36-35b-a3b-fp8-tp1-r1"
    assert md["launch"]["file"] == "prod/small-models.yaml" and len(md["launch"]["file_sha256"]) == 64


def test_the_live_software_is_pinned_in_the_repository(live):
    report, nonce, model = live
    fps, _ = S.fingerprints(report, nonce, model)
    assert S.unpinned(fps, model, S.load_pins()) == []


def test_a_changed_container_setup_is_caught(live):
    report, nonce, model = copy.deepcopy(live)
    md = parts(report)[1]
    tcb = json.loads(md["info"]["tcb_info"]) if isinstance(md["info"]["tcb_info"], str) else md["info"]["tcb_info"]
    tcb["app_compose"] = tcb["app_compose"].replace("compose-manager", "evil-manager", 1)
    md["info"]["tcb_info"] = tcb
    assert any("container setup does not match" in p for p in S.fingerprints(report, nonce, model)[1])


def test_an_edited_event_log_does_not_replay(live):
    report, nonce, model = copy.deepcopy(live)
    md = parts(report)[1]
    log = json.loads(md["event_log"]) if isinstance(md["event_log"], str) else md["event_log"]
    for e in log:
        if e["imr"] == 3 and e["event"] == "os-image-hash":
            e["event_payload"] = "00" * 32
    md["event_log"] = log
    assert any("does not replay to the quote's RTMR3" in p for p in S.fingerprints(report, nonce, model)[1])


def test_an_edited_launch_log_or_another_nonce_is_caught(live):
    report, nonce, model = copy.deepcopy(live)
    md = parts(report)[1]
    cm = json.loads(md["compose_manager_attestation"]) if isinstance(md["compose_manager_attestation"], str) \
        else md["compose_manager_attestation"]
    cm["actions"][-1]["file_sha256"] = "00" * 32
    md["compose_manager_attestation"] = cm
    assert any("launch log does not match its signed hash" in p for p in S.fingerprints(report, nonce, model)[1])
    report2, nonce2, model2 = copy.deepcopy(live)
    assert any("does not hold its hash and our nonce" in p for p in S.fingerprints(report2, "11" * 32, model2)[1])


def test_a_model_with_no_running_container_is_caught(live):
    report, nonce, _ = live
    assert any("no running container" in p for p in S.fingerprints(report, nonce, "Qwen/Some-Other-Model")[1])


def test_unpinned_software_is_held_and_pinning_is_explicit(live, tmp_path):
    report, nonce, model = live
    fps, _ = S.fingerprints(report, nonce, model)
    pins = tmp_path / "pins.json"
    assert S.unpinned(fps, model, S.load_pins(pins)) == fps  # nothing pinned: everything is new
    assert S.pin(fps, model, pins) == 2 and S.pin(fps, model, pins) == 0
    assert S.unpinned(fps, model, S.load_pins(pins)) == []
    changed = copy.deepcopy(fps)
    changed[1]["launch"]["tag"] = "v9.9.9"  # NEAR redeployed the model: not trusted until pinned again
    assert S.unpinned(changed, model, S.load_pins(pins)) == [changed[1]]


def test_the_read_flow_holds_an_answer_from_unpinned_software(live, tmp_path, monkeypatch):
    from ctp_reader import Prepared
    from ctp_reader import model as M
    record = json.loads(LIVE.read_text())
    monkeypatch.setenv("CTP_CACHE", str(tmp_path))
    monkeypatch.setattr(M, "hardware_problems", lambda record: [])  # tested on its own in test_hardware.py
    p = Prepared(sha256=record["evidence"]["document_sha256"], text="")
    M._store(p.sha256, M.MODEL, record)
    route = {"chain": "near", "token": "t", "address": "a"}
    assert M.read_invoice(p, token="t", payee_route=route).held == []  # pinned in the repository
    monkeypatch.setattr(S, "load_pins", lambda path=S.PINS: {})
    r = M.read_invoice(p, token="t", payee_route=route)
    assert r.held == ["model_software_unpinned"] and len(r.evidence["unpinned_software"]) == 2


def test_hardware_also_verifies_the_launch_log_quote(live):
    report, nonce, _ = live

    def verify(q, collateral, now):
        return {"status": "UpToDate", "advisory_ids": [], "report_data": q[568:632].hex()}

    from test_hardware import NVIDIA_KEY, jwk, token
    tok = token(True)
    h = H.check(report, nonce, fetch=lambda q: "c", verify=verify, gpu=lambda p: tok, keys=lambda: [jwk(NVIDIA_KEY)], now=1)
    assert h["problems"] == [] and len(h["intel_launch_log"]) == 1
    h2 = H.check(report, "22" * 32, fetch=lambda q: "c", verify=verify, gpu=lambda p: tok, keys=lambda: [jwk(NVIDIA_KEY)], now=1)
    assert any("launch log's verified quote does not hold its hash and our nonce" in p for p in h2["problems"])


def test_the_pins_file_is_plain_reviewable_json():
    pins = json.loads(S.PINS.read_text())
    assert list(pins) == ["Qwen/Qwen3.6-35B-A3B-FP8"]
    assert hashlib.sha256(S.PINS.read_bytes()).hexdigest()  # committed, so any change shows in review
