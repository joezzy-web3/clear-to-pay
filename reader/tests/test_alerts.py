"""Alerts: each change on the contract becomes one message to the right person. Offline.

Run from reader/:  python3 -m pytest -q tests/test_alerts.py
"""

import copy
import json

import pytest

from ctp_reader import alerts

H = 3600 * 10**9
T = 1_793_600_000 * 10**9
USDC = "usdc.testnet"


class Chain:
    """A fake contract: tests edit `s`, the watcher reads it through the same views."""

    def __init__(self):
        self.s = {
            "receipts": [{"id": 0, "verdict": "Seized", "reasons": ["payee_mismatch"], "invoice_number": "INV-2210",
                          "supplier_id": "qingmar-steel", "amount": "7800000", "order_id": "PO-1184"}],
            "payments": {},
            "supplier": {"route_on_file": {"address": "qingmar.cleartopay.testnet"}, "route_payable_from": str(T), "pending": None},
            "signers": [{"key": "ed25519:D9PKouihN73fDQsqsYE9cXvryoBDxnh9Jut6teNGCrW6", "role": "storekeeper"},
                        {"key": "ed25519:BzrpxezSnTwF2EkdRarHKo4fMZeFCeKtjGHwLDWfknrC", "role": "weighbridge"}],
            "funds": {"available": "60000000", "reserved": "0"},
        }
        self.calls = []

    def __call__(self, method, args):
        self.calls.append(method)
        s = self.s
        return {
            "receipt_count": lambda: len(s["receipts"]),
            "get_receipt": lambda: s["receipts"][args["receipt_id"]],
            "get_payment": lambda: s["payments"].get(args["receipt_id"]),
            "get_supplier": lambda: s["supplier"] if args["supplier_id"] == "qingmar-steel" else None,
            "get_delivery_signers": lambda: s["signers"],
            "get_funds": lambda: s["funds"],
        }[method]()

    def receipt(self, verdict, reasons, number, amount="7800000"):
        self.s["receipts"].append({"id": len(self.s["receipts"]), "verdict": verdict, "reasons": reasons,
                                   "invoice_number": number, "supplier_id": "qingmar-steel", "amount": amount,
                                   "order_id": "PO-1184"})


@pytest.fixture
def run(tmp_path):
    chain, sent = Chain(), []

    def poll(replay=False):
        before = len(sent)
        alerts.tick(view=chain, suppliers=["qingmar-steel"], token=USDC, state_path=tmp_path / "s.json",
                    send=sent.append, contract="guard.cleartopay.testnet", replay=replay)
        return sent[before:]

    return chain, poll


def test_the_first_run_remembers_without_announcing(run):
    chain, poll = run
    assert poll() == []
    assert poll() == []


def test_replay_announces_what_already_happened(run):
    chain, poll = run
    msgs = poll(replay=True)
    assert len(msgs) == 1 and "SEIZED invoice INV-2210" in msgs[0] and "Do not reply" in msgs[0]


def test_a_proposed_address_change_is_an_alarm_with_the_earliest_payable_time(run):
    chain, poll = run
    poll()
    chain.s["supplier"]["pending"] = {"route": {"address": "qingmar-payments.testnet"}, "proposed_at": str(T), "approved": False}
    (msg,) = poll()
    assert msg.startswith("ALERT")
    assert "qingmar.cleartopay.testnet -> qingmar-payments.testnet" in msg
    assert alerts.when(T + 72 * H) in msg and "cancel_payout_change" in msg


def test_approval_and_cancellation_are_reported(run):
    chain, poll = run
    chain.s["supplier"]["pending"] = {"route": {"address": "new.testnet"}, "proposed_at": str(T), "approved": False}
    poll()
    chain.s["supplier"]["pending"] = dict(chain.s["supplier"]["pending"], approved=True)
    assert "APPROVED" in poll()[0]
    chain.s["supplier"]["pending"] = None
    assert "was cancelled" in poll()[0]


def test_a_change_that_took_effect_is_reported(run):
    chain, poll = run
    chain.s["supplier"]["pending"] = {"route": {"address": "new.testnet"}, "proposed_at": str(T), "approved": True}
    poll()
    chain.s["supplier"].update(pending=None, route_on_file={"address": "new.testnet"})
    assert "now new.testnet" in poll()[0]


def test_an_added_delivery_signer_is_an_alarm(run):
    chain, poll = run
    poll()
    chain.s["signers"].append({"key": "ed25519:7stolenKeyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", "role": "storekeeper"})
    (msg,) = poll()
    assert msg.startswith("ALERT") and "Delivery signer ADDED" in msg


def test_held_says_whose_job_it_is(run):
    chain, poll = run
    poll()
    chain.receipt("Held", ["payee_not_yet_payable", "quantity_exceeds_delivery"], "INV-2209", "9360000")
    (msg,) = poll()
    assert "HELD invoice INV-2209" in msg and "9.36 USDC" in msg
    assert "72-hour wait" in msg and "Supplier to correct: quantity_exceeds_delivery" in msg and "next_step.py 1" in msg


def test_a_cleared_invoice_and_its_payment_are_followed_to_the_end(run):
    chain, poll = run
    poll()
    chain.receipt("Cleared", [], "INV-2208")
    chain.s["payments"][1] = {"status": "Submitted", "amount": "7800000", "attempt": 1, "recipient": {"address": "qingmar.cleartopay.testnet"}}
    chain.s["funds"] = {"available": "52200000", "reserved": "7800000"}
    msgs = poll()
    assert any("CLEARED invoice INV-2208" in m for m in msgs) and any("Payment sent for INV-2208" in m for m in msgs)
    chain.s["payments"][1] = dict(chain.s["payments"][1], status="Settled")
    chain.s["funds"] = {"available": "52200000", "reserved": "0"}
    msgs = poll()
    assert msgs == ["Clear to Pay | guard.cleartopay.testnet\nPAID: 7.80 USDC for INV-2208 reached qingmar.cleartopay.testnet."]
    calls = len(chain.calls)
    poll()  # a settled payment is not fetched again
    assert "get_payment" not in chain.calls[calls:]


def test_a_failed_payment_is_an_alarm(run):
    chain, poll = run
    chain.receipt("Cleared", [], "INV-2208")
    chain.s["payments"][1] = {"status": "Submitted", "amount": "7800000", "attempt": 1, "recipient": {"address": "q.testnet"}}
    poll()
    chain.s["payments"][1] = dict(chain.s["payments"][1], status="Failed")
    (msg,) = poll()
    assert msg.startswith("ALERT") and "FAILED" in msg and "back in the pool" in msg


def test_deposits_and_unexplained_drops_in_the_pool(run):
    chain, poll = run
    poll()
    chain.s["funds"] = {"available": "80000000", "reserved": "0"}
    assert "Deposit: pool +20.00 USDC" in poll()[0]
    chain.s["funds"] = {"available": "50000000", "reserved": "0"}
    (msg,) = poll()
    assert msg.startswith("ALERT") and "Pool down 30.00 USDC" in msg


def test_nothing_new_means_no_message(run):
    chain, poll = run
    poll()
    assert poll() == [] and poll() == []


def test_if_sending_fails_nothing_is_forgotten(run, tmp_path):
    chain, poll = run
    poll()
    chain.receipt("Held", ["price_mismatch"], "INV-2212")

    def broken(_):
        raise RuntimeError("Telegram unreachable")

    with pytest.raises(RuntimeError):
        alerts.tick(view=chain, suppliers=["qingmar-steel"], token=USDC, state_path=tmp_path / "s.json",
                    send=broken, contract="c", replay=False)
    assert "HELD invoice INV-2212" in poll()[0]  # announced on the next good poll


def test_telegram_never_puts_the_token_in_an_error(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:SECRET")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    seen = {}

    def post(url, data):
        seen["url"], seen["data"] = url, data
        return json.dumps({"ok": True}).encode()

    alerts.telegram("hi", post=post)
    assert seen["url"].endswith("/sendMessage") and b"chat_id=42" in seen["data"]

    import urllib.error

    def refuse(url, data):
        raise urllib.error.HTTPError(url, 401, "Unauthorized", None, None)

    with pytest.raises(RuntimeError) as e:
        alerts.telegram("hi", post=refuse)
    assert "SECRET" not in str(e.value) and "401" in str(e.value)


def test_missing_telegram_settings_are_a_clear_error(monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="TELEGRAM_BOT_TOKEN"):
        alerts.telegram("hi")


def test_snapshot_is_plain_json(run, tmp_path):
    chain, poll = run
    poll()
    state = json.loads((tmp_path / "s.json").read_text())
    assert copy.deepcopy(state) == state and state["funds"]["available"] == "60000000"
