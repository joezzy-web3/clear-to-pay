"""The last link: check the attestation report down to the hardware (fourth review, CTP4-04).

`model.verify()` already requires each report part to carry our nonce and its Intel TDX
quote to hold the enclave's signing address and our nonce in REPORTDATA. Here we check that
the quote itself is genuine and that the GPU is a genuine NVIDIA confidential-computing GPU:

  Intel  `dcap-qvl` verifies the TDX quote's signature chain to Intel's root CA, with
         collateral (certificates, revocation lists, TCB info) fetched from Intel's own
         Provisioning Certification Service. The verified REPORTDATA must equal the
         enclave's signing address + our nonce. The collateral is saved, so anyone can
         re-run the Intel check later, offline, at the same point in time.
  NVIDIA the GPU evidence (which must carry our nonce) is sent to NVIDIA's Remote
         Attestation Service; its signed verdict must be true. The returned token is saved.

The same steps as NEAR's own verifier (github.com/nearai/nearai-cloud-verifier). Needs
network access to Intel and NVIDIA and the `dcap-qvl` package (pip install dcap-qvl);
nothing here is needed to read invoices without it.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
import urllib.error
import urllib.request

INTEL_PCS = "https://api.trustedservices.intel.com"
NRAS = "https://nras.attestation.nvidia.com/v3/attest/gpu"
# TCB statuses that still mean "a genuine, correctly signed TDX quote". OutOfDate means the
# platform is behind Intel's latest advisory baseline, not that the quote is forged; it is
# accepted (as NEAR's verifier does) and recorded with its advisory IDs.
ACCEPTED = {"UpToDate", "SWHardeningNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded",
            "OutOfDate", "OutOfDateConfigurationNeeded"}


class HardwareError(RuntimeError):
    pass


def _dcap():
    try:
        import dcap_qvl  # noqa: PLC0415 - optional
    except ImportError:
        raise HardwareError("dcap-qvl is not installed: pip install dcap-qvl") from None
    return dcap_qvl


def fetch_collateral(quote: bytes) -> str:
    """Intel's collateral for this quote, as JSON (network)."""
    d = _dcap()
    try:
        async def fetch():  # dcap-qvl's request must be created inside a running event loop
            return await d.get_collateral(INTEL_PCS, quote)

        return asyncio.run(fetch()).to_json()
    except (ValueError, RuntimeError) as e:
        raise HardwareError(f"could not fetch Intel collateral: {e}") from None


def verify_quote(quote: bytes, collateral_json: str, now: int) -> dict:
    """Verify the quote's signature chain with the given collateral (offline). Returns status and REPORTDATA."""
    d = _dcap()
    try:
        res = d.verify(quote, d.QuoteCollateralV3.from_json(collateral_json), now)
    except (ValueError, RuntimeError) as e:
        raise HardwareError(f"Intel quote did not verify: {e}") from None
    j = json.loads(res.to_json())
    body = j.get("report") or {}
    td = body.get("TD10") or body.get("TD15") or {}
    rd = td.get("report_data") or ""
    if not rd:  # same bytes Intel's signature was just checked over; read them with the parser
        rd = d.parse_quote(quote).report.report_data.hex()
    return {"status": res.status, "advisory_ids": list(res.advisory_ids or []), "report_data": rd}


def nras(payload: dict) -> str:
    """NVIDIA's signed verdict (a JWT) for the GPU evidence (network)."""
    req = urllib.request.Request(NRAS, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.loads(r.read())
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise HardwareError(f"NVIDIA attestation service: {getattr(e, 'reason', e)}") from None
    try:
        return body[0][1]
    except (IndexError, KeyError, TypeError):
        raise HardwareError("NVIDIA attestation service: unexpected answer") from None


def jwt_claims(token: str) -> dict:
    part = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


def check(report: dict, nonce: str, *, saved: dict | None = None, fetch=fetch_collateral, verify=verify_quote,
          gpu=nras, now: int | None = None) -> dict:
    """Check every report part down to the hardware.

    With `saved` (an earlier result), the Intel check is re-run offline with the saved
    collateral at the saved time, and the NVIDIA verdict is read from the saved token.
    Returns {"problems": [...], "intel": [...], "nvidia": [...], "checked_at": ...}.
    """
    from .model import report_parts  # noqa: PLC0415

    out = {"problems": [], "intel": [], "nvidia": [], "checked_at": int(now or time.time())}
    if saved:
        out["checked_at"] = int(saved.get("checked_at", out["checked_at"]))
    parts = report_parts(report)
    if not parts:
        out["problems"].append("no attestation parts to check")
    for i, (kind, part) in enumerate(parts):
        label = f"{kind} enclave {part.get('signing_address', '?')}"
        try:
            quote = bytes.fromhex(part.get("intel_quote", ""))
        except ValueError:
            out["problems"].append(f"{label}: quote is not hex")
            continue
        try:
            coll = saved["intel"][i]["collateral"] if saved else fetch(quote)
            got = verify(quote, coll, out["checked_at"])
        except (HardwareError, KeyError, IndexError, TypeError) as e:
            out["problems"].append(f"{label}: {e}")
            continue
        want = bytes.fromhex(str(part.get("signing_address", "0x"))[2:]).ljust(32, b"\0").hex() + nonce
        if got["status"] not in ACCEPTED:
            out["problems"].append(f"{label}: Intel TCB status {got['status']}")
        if str(got["report_data"]).lower().removeprefix("0x") != want.lower():
            out["problems"].append(f"{label}: the verified quote does not hold this enclave's address and our nonce")
        out["intel"].append({"kind": kind, "signing_address": part.get("signing_address"), **got, "collateral": coll})
        if kind != "model":
            continue
        try:
            payload = json.loads(part.get("nvidia_payload") or "{}")
        except ValueError:
            payload = {}
        if str(payload.get("nonce", "")).lower() != nonce.lower():
            out["problems"].append(f"{label}: the GPU evidence does not carry our nonce")
            continue
        try:
            token = saved["nvidia"][len(out["nvidia"])]["token"] if saved else gpu(payload)
            verdict = jwt_claims(token).get("x-nvidia-overall-att-result")
        except (HardwareError, KeyError, IndexError, TypeError, ValueError) as e:
            out["problems"].append(f"{label}: {e}")
            continue
        if verdict is not True:
            out["problems"].append(f"{label}: NVIDIA's verdict is {verdict!r}, not true")
        out["nvidia"].append({"signing_address": part.get("signing_address"), "verdict": verdict, "token": token})
    return out
