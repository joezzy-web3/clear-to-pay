"""Read-only views of the Clear to Pay contract over NEAR JSON-RPC. No keys, standard library only."""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request

CONTRACT = os.environ.get("CTP_CONTRACT", "guard.cleartopay.testnet")
RPCS = [u for u in os.environ.get("CTP_RPC", "").split(",") if u] or [
    "https://rpc.testnet.fastnear.com",
    "https://rpc.testnet.near.org",
]


class ChainError(RuntimeError):
    pass


def view(method: str, args: dict, *, contract: str = CONTRACT, post=None) -> object:
    body = json.dumps({
        "jsonrpc": "2.0", "id": "ctp", "method": "query",
        "params": {"request_type": "call_function", "finality": "final", "account_id": contract,
                   "method_name": method, "args_base64": base64.b64encode(json.dumps(args).encode()).decode()},
    }).encode()
    last = None
    for url in RPCS:
        try:
            raw = post(url, body) if post else _post(url, body)
            data = json.loads(raw)
            if "error" in data:
                raise ChainError(str(data["error"])[:200])
            if "error" in data.get("result", {}):
                raise ChainError(str(data["result"]["error"])[:200])
            return json.loads(bytes(data["result"]["result"]))
        except (OSError, ValueError, KeyError, ChainError) as e:
            last = e
    raise ChainError(f"{method}: no RPC answered ({last})")


def view_each(method: str, args: dict, *, contract: str = CONTRACT, post=None) -> list:
    """The same view from every RPC that answers, for cross-checking security-sensitive state."""
    out = []
    for url in RPCS:
        try:
            out.append(view(method, args, contract=contract, post=(lambda _u, b, url=url: (post or _post)(url, b))))
        except ChainError:
            pass
    return out


def _post(url: str, body: bytes) -> bytes:
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()


def receipt(receipt_id: int, **kw) -> dict | None:
    return view("get_receipt", {"receipt_id": receipt_id}, **kw)


def order(order_id: str, **kw) -> dict | None:
    return view("get_order", {"order_id": order_id}, **kw)
