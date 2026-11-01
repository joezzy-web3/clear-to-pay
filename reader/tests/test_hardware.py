"""The hardware step (Intel TDX quote chain, NVIDIA GPU verdict), with Intel and NVIDIA faked. Offline.

Run from reader/:  python3 -m pytest -q tests/test_hardware.py
"""

import base64
import json

import pytest

from ctp_reader import hardware as H
from test_model import quote

NONCE = "ab" * 32
MODEL_ADDR, GW_ADDR = "0x" + "11" * 20, "0x" + "22" * 20


def token(verdict):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa: E731
    return f"{enc({'alg': 'ES384'})}.{enc({'x-nvidia-overall-att-result': verdict})}.sig"


def report(gpu_nonce=NONCE):
    return {
        "gateway_attestation": {"signing_address": GW_ADDR, "request_nonce": NONCE, "intel_quote": quote(GW_ADDR, NONCE)},
        "model_attestations": [{"signing_address": MODEL_ADDR, "request_nonce": NONCE, "intel_quote": quote(MODEL_ADDR, NONCE),
                                "model_name": "m", "nvidia_payload": json.dumps({"nonce": gpu_nonce, "evidence_list": []})}],
    }


def fake_verify(status="UpToDate", lie=False):
    def verify(q, collateral, now):
        assert collateral == "collateral-json" and isinstance(now, int)
        rd = bytes.fromhex(q.hex()[1136:1264])  # REPORTDATA at offset 568
        return {"status": status, "advisory_ids": ["INTEL-SA-00837"] if status == "OutOfDate" else [],
                "report_data": "0x" + ("00" * 64 if lie else rd.hex())}
    return verify


def run(rep=None, verdict=True, **kw):
    sent = []
    h = H.check(rep or report(), NONCE, fetch=lambda q: "collateral-json", verify=kw.get("verify", fake_verify()),
                gpu=lambda payload: sent.append(payload) or token(verdict), now=1_793_600_000)
    return h, sent


def test_genuine_hardware_passes_and_records_what_it_saw():
    h, sent = run()
    assert h["problems"] == []
    assert [i["kind"] for i in h["intel"]] == ["gateway", "model"] and h["intel"][0]["collateral"] == "collateral-json"
    assert h["nvidia"][0]["verdict"] is True and sent[0]["nonce"] == NONCE


def test_a_quote_whose_verified_report_data_differs_fails():
    h, _ = run(verify=fake_verify(lie=True))
    assert any("does not hold this enclave's address and our nonce" in p for p in h["problems"])


def test_a_revoked_platform_fails_and_out_of_date_is_recorded_not_hidden():
    assert any("Revoked" in p for p in run(verify=fake_verify("Revoked"))[0]["problems"])
    h, _ = run(verify=fake_verify("OutOfDate"))
    assert h["problems"] == [] and h["intel"][0]["advisory_ids"] == ["INTEL-SA-00837"]


def test_a_quote_that_does_not_verify_fails():
    def broken(q, c, now):
        raise H.HardwareError("Intel quote did not verify: bad signature")
    assert any("bad signature" in p for p in run(verify=broken)[0]["problems"])


def test_gpu_evidence_must_carry_our_nonce_and_nvidia_must_say_true():
    h, sent = run(report(gpu_nonce="cd" * 32))
    assert any("GPU evidence does not carry our nonce" in p for p in h["problems"]) and sent == []
    assert any("NVIDIA's verdict is False" in p for p in run(verdict=False)[0]["problems"])


def test_a_saved_result_is_rechecked_offline_with_the_saved_collateral_and_time():
    first, _ = run()
    seen = {}

    def verify(q, collateral, now):
        seen["now"] = now
        return fake_verify()(q, collateral, now)

    def no_network(*a):
        raise AssertionError("must not fetch")

    again = H.check(report(), NONCE, saved=first, fetch=no_network, verify=verify, gpu=no_network)
    assert again["problems"] == [] and seen["now"] == first["checked_at"]


def test_without_dcap_qvl_the_error_says_how_to_install_it(monkeypatch):
    import builtins
    real = builtins.__import__
    monkeypatch.setattr(builtins, "__import__", lambda n, *a, **k: (_ for _ in ()).throw(ImportError()) if n == "dcap_qvl" else real(n, *a, **k))
    with pytest.raises(H.HardwareError, match="pip install dcap-qvl"):
        H.fetch_collateral(b"")
