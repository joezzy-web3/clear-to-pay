"""Clear to Pay as an MCP server: the protocol, the read tools and the fence on the two tools that send. Offline.

Run from reader/:  python3 -m pytest -q tests/test_mcp.py
"""

import io
import json
import subprocess
from pathlib import Path

import pytest

from ctp_reader import chain
from ctp_reader import mcp_server as S

HERE = Path(__file__).resolve().parent.parent
REPO = HERE.parent
PUB = "ed25519:6ZnC3JFuTwHksSLZev3Vbbe24hjKdZs52gFphrLctcWp"


def rpc(*msgs):
    out = io.StringIO()
    S.serve(io.StringIO("\n".join(json.dumps(m) for m in msgs) + "\n"), out)
    return [json.loads(line) for line in out.getvalue().splitlines()]


def tool(name, **args):
    return S.call(name, args)


def test_the_handshake_and_the_tool_list():
    a, b = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
               {"jsonrpc": "2.0", "method": "notifications/initialized"},
               {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    assert a["result"]["protocolVersion"] == "2025-06-18" and "code decides" in a["result"]["instructions"]
    names = [t["name"] for t in b["result"]["tools"]]
    assert names[0] == "inspect_invoice" and {"submit_invoice", "retry_payment"} <= set(names)
    sends = {t["name"] for t in b["result"]["tools"] if not t["annotations"]["readOnlyHint"]}
    assert sends == {"submit_invoice", "retry_payment"}  # everything else only looks


def test_reads_that_rpc_servers_disagree_on_are_errors(monkeypatch):
    monkeypatch.setattr(chain, "view_each", lambda m, a, **k: [{"verdict": "Held"}, {"verdict": "Cleared"}])
    assert "disagree" in tool("get_receipt", receipt_id=1)["content"][0]["text"]
    monkeypatch.setattr(chain, "view_each", lambda m, a, **k: [{"verdict": "Held"}])
    assert "only 1 of 2" in tool("get_receipt", receipt_id=1)["content"][0]["text"]


def test_malformed_messages_get_errors_and_the_server_keeps_running():
    replies = rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": [1, 2]},
                  {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "pool", "arguments": [[1]]}},
                  {"jsonrpc": "2.0", "id": 3, "method": 7},
                  {"jsonrpc": "2.0", "id": 4, "method": "ping"})
    assert [r.get("error", {}).get("code") for r in replies] == [-32602, -32602, -32600, None]
    assert replies[-1]["result"] == {}


def test_the_ai_checks_are_reported_one_by_one():
    assert S.checks_passed([]) == {"signed_answer": "passed", "software_pinned": "passed", "hardware": "passed"}
    assert S.checks_passed(["model_software_unpinned"]) == {"signed_answer": "passed", "software_pinned": "FAILED",
                                                            "hardware": "not run"}
    assert S.checks_passed(["model_daily_cap_reached"])["signed_answer"] == "not run"


def test_unknown_methods_tools_and_arguments_are_errors_not_crashes():
    (r,) = rpc({"jsonrpc": "2.0", "id": 1, "method": "resources/list"})
    assert r["error"]["code"] == -32601
    assert tool("pay_anyone", to="x")["isError"]
    assert "unexpected ['payee']" in tool("get_receipt", receipt_id=0, payee="x")["content"][0]["text"]
    out = io.StringIO()
    S.serve(io.StringIO("not json\n"), out)
    assert json.loads(out.getvalue())["error"]["code"] == -32700


@pytest.fixture(autouse=True)
def docs(monkeypatch):
    monkeypatch.setenv("CTP_MCP_DOCS", str(HERE))  # the reader folder stands in for the documents folder


def test_a_poisoned_pdf_is_held_and_its_hidden_words_never_reach_the_agent():
    r = tool("inspect_invoice", pdf_path="corpus/02-white-text-payee.pdf")
    text = r["content"][0]["text"]
    assert not r["isError"] and r["structuredContent"]["held"] == ["hidden_text"]
    assert "qingmar-payments" not in text and "bank details" not in text  # the instruction is withheld
    assert r["structuredContent"]["hidden_text_dropped"][0]["reason"] == "white_text"


def test_a_clean_pdf_is_not_sent_to_the_ai_unless_asked():
    r = tool("inspect_invoice", pdf_path="corpus/01-clean.pdf")
    assert r["structuredContent"]["held"] == [] and "nothing spent" in r["structuredContent"]["verdict"]
    assert tool("inspect_invoice", pdf_path="README.md")["isError"]


def test_files_outside_the_documents_folder_are_refused(tmp_path, monkeypatch):
    for bad in [str(HERE / "corpus" / "01-clean.pdf"), "../README.md", "../docs/proof/reading-INV-2208.json"]:
        r = tool("verify_reading", path=bad) if bad.endswith(".json") else tool("inspect_invoice", pdf_path=bad)
        assert r["isError"], bad
    (tmp_path / "corpus").mkdir()
    (tmp_path / "corpus" / "x.pdf").symlink_to(HERE / "corpus" / "01-clean.pdf")
    monkeypatch.setenv("CTP_MCP_DOCS", str(tmp_path))
    assert "links" in tool("inspect_invoice", pdf_path="corpus/x.pdf")["content"][0]["text"]
    monkeypatch.delenv("CTP_MCP_DOCS")
    assert "CTP_MCP_DOCS" in tool("inspect_invoice", pdf_path="corpus/01-clean.pdf")["content"][0]["text"]


def test_receipts_are_read_from_the_contract(monkeypatch):
    rec = {"id": 0, "verdict": "Seized", "reasons": ["payee_mismatch"], "supplier_id": "qingmar-steel",
           "invoice_number": "INV-2210", "order_id": "PO-1184", "amount": "7800000",
           "payee": {"address": "qingmar-payments.testnet"}, "document_hash": "a0", "decided_at": "1"}
    monkeypatch.setattr(chain, "view_each", lambda m, a, **k: [{"get_receipt": rec, "get_payment": None}[m]] * len(chain.RPCS))
    r = tool("get_receipt", receipt_id=0)["structuredContent"]
    assert r["verdict"] == "Seized" and r["amount_usdc"] == "7.80" and "payment" not in r


def test_sending_is_off_unless_the_operator_turns_it_on(monkeypatch):
    monkeypatch.delenv("CTP_MCP_ALLOW_SUBMIT", raising=False)
    r = tool("submit_invoice", args_path="args.json")
    assert r["isError"] and "sending is off" in r["content"][0]["text"]


@pytest.fixture
def agent(tmp_path, monkeypatch):
    key = tmp_path / "agent.json"
    key.write_text(json.dumps({"account_id": "buyer.cleartopay.testnet", "public_key": PUB, "private_key": "ed25519:SECRET"}))
    args = tmp_path / "args.json"
    args.write_text(json.dumps({"invoice": {"invoice_number": "INV-1"}, "supplier_signature": "c2ln"}))
    monkeypatch.setenv("CTP_MCP_DOCS", str(tmp_path))
    monkeypatch.setenv("CTP_MCP_ALLOW_SUBMIT", "1")
    monkeypatch.setenv("CTP_AGENT_ACCOUNT", "buyer.cleartopay.testnet")
    monkeypatch.setenv("CTP_AGENT_KEY_FILE", str(key))
    return key, args


def chain_says(permission):
    return lambda url, body: json.dumps({"result": {"nonce": 1, "permission": permission}}).encode()


FENCED = {"FunctionCall": {"allowance": "250000000000000000000000", "receiver_id": "guard.cleartopay.testnet",
                           "method_names": ["submit_invoice", "execute_payment"]}}


class Near:
    def __init__(self, code=0):
        self.code, self.cmd = code, None

    def __call__(self, cmd, **kw):
        self.cmd = cmd
        return subprocess.CompletedProcess(cmd, self.code, stdout='{"receipt_id": 4, "verdict": "Held"}',
                                           stderr="Transaction ID: 4WjgwSR4Pvx8QTfpwjcaGAKHc4s5h7in6D4L82aTQA8L\n")


@pytest.mark.parametrize("perm,why", [
    ("FullAccess", "FULL-ACCESS"),
    ({"FunctionCall": {"allowance": None, "receiver_id": "guard.cleartopay.testnet",
                       "method_names": ["submit_invoice"]}}, "allowance must be set"),  # unlimited gas
    ({"FunctionCall": {"allowance": str(5 * 10**24), "receiver_id": "guard.cleartopay.testnet",
                       "method_names": ["submit_invoice"]}}, "allowance must be set"),
    ({"FunctionCall": {"allowance": "1", "receiver_id": "guard.cleartopay.testnet", "method_names": []}}, "must be limited"),  # [] = any method
    ({"FunctionCall": {"allowance": "1", "receiver_id": "guard.cleartopay.testnet", "method_names": ["submit_invoice", "withdraw"]}}, "must be limited"),
    ({"FunctionCall": {"allowance": "1", "receiver_id": "usdc.testnet", "method_names": ["submit_invoice"]}}, "must be limited"),
])
def test_a_key_that_is_not_fenced_is_refused_before_anything_is_sent(agent, perm, why):
    _, args = agent
    near = Near()
    with pytest.raises(S.ToolError, match=why):
        S.submit_invoice(args.name, rpc=chain_says(perm), run=near)
    assert near.cmd is None  # nothing was signed


def test_a_fenced_key_submits_and_the_key_never_appears_in_the_answer(agent):
    key, args = agent
    near = Near()
    out = S.submit_invoice(args.name, rpc=chain_says(FENCED), run=near)
    assert out["result"]["verdict"] == "Held" and out["transaction"].startswith("4Wjgw")
    assert near.cmd[near.cmd.index("sign-with-access-key-file") + 1] == str(key)
    assert near.cmd[near.cmd.index("attached-deposit") + 1] == "0 NEAR"
    assert "SECRET" not in json.dumps(out) and str(key) not in json.dumps(out)


def test_a_retry_can_only_execute_a_payment_by_receipt(agent):
    near = Near()
    S.retry_payment(3, rpc=chain_says(FENCED), run=near)
    assert near.cmd[5:8] == ["execute_payment", "json-args", '{"receipt_id": 3}']


def test_a_key_the_chain_does_not_know_is_refused(agent):
    _, args = agent
    with pytest.raises(S.ToolError, match="not on"):
        S.submit_invoice(args.name, rpc=lambda u, b: json.dumps({"result": {"error": "access key does not exist"}}).encode(),
                         run=Near())


def test_rpc_servers_that_disagree_about_the_key_mean_nothing_is_sent(agent, monkeypatch):
    _, args = agent
    monkeypatch.setattr(chain, "RPCS", ["https://a", "https://b"])
    answers = {"https://a": FENCED, "https://b": "FullAccess"}  # one server lies
    near = Near()
    with pytest.raises(S.ToolError, match="disagree"):
        S.submit_invoice(args.name, rpc=lambda url, body: json.dumps({"result": {"permission": answers[url]}}).encode(),
                         run=near)
    assert near.cmd is None


def test_a_server_that_does_not_answer_means_nothing_is_sent(agent, monkeypatch):
    _, args = agent
    monkeypatch.setattr(chain, "RPCS", ["https://a", "https://b"])

    def rpc(url, body):  # a lies, b is down: the lie must not pass on its own
        if url == "https://b":
            raise OSError("down")
        return json.dumps({"result": {"permission": FENCED}}).encode()
    near = Near()
    with pytest.raises(S.ToolError, match="only 1 of 2"):
        S.submit_invoice(args.name, rpc=rpc, run=near)
    assert near.cmd is None
