"""Check that an AI answer was signed inside NEAR AI Cloud's TEE. No dependencies.

NEAR AI Cloud signs every chat answer with a key that never leaves the TEE:

    text      = "{model}:{sha256(request bytes)}:{sha256(response bytes)}"   (model TEE)
             or "{sha256(request bytes)}:{sha256(response bytes)}"           (gateway TEE)
    signature = an Ethereum-style personal-message signature (secp256k1) over `text`

The signer's address is published in the hardware attestation report
(`signing_address`). This module recovers the signer from the signature and checks
that the signed hashes are the hashes of the exact bytes we sent and received.

Not done here: verifying the attestation report itself against NVIDIA NRAS and Intel
TDX (the hardware chain). We record the report and its nonce next to every answer so
that can be checked with NEAR's verifier (github.com/nearai/nearai-cloud-verifier).
"""

from __future__ import annotations

import hashlib

# ---------------------------------------------------------------- keccak-256 (Ethereum's, not SHA3-256)

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
]
_M = (1 << 64) - 1


def _rol(v: int, n: int) -> int:
    return ((v << n) | (v >> (64 - n))) & _M if n else v


def _keccak_f(a: list[list[int]]) -> None:
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                a[x][y] ^= d[x]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        for x in range(5):
            for y in range(5):
                a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])
        a[0][0] ^= rc


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data) + b"\x01"
    msg += b"\x00" * ((-len(msg)) % rate)
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        block = msg[off:off + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            a[x][y] ^= int.from_bytes(block[8 * i:8 * i + 8], "little")
        _keccak_f(a)
    out = b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out[:32]


# ---------------------------------------------------------------- secp256k1 public-key recovery

_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
      0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


def _add(p, q):
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0] and (p[1] + q[1]) % _P == 0:
        return None
    if p == q:
        lam = 3 * p[0] * p[0] * pow(2 * p[1], -1, _P) % _P
    else:
        lam = (q[1] - p[1]) * pow(q[0] - p[0], -1, _P) % _P
    x = (lam * lam - p[0] - q[0]) % _P
    return (x, (lam * (p[0] - x) - p[1]) % _P)


def _mul(k: int, p):
    r = None
    while k:
        if k & 1:
            r = _add(r, p)
        p = _add(p, p)
        k >>= 1
    return r


def _recover(msg_hash: bytes, sig: bytes):
    if len(sig) != 65:
        raise ValueError("signature must be 65 bytes")
    r, s, v = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:64], "big"), sig[64]
    if v >= 27:
        v -= 27
    if v not in (0, 1) or not (1 <= r < _N and 1 <= s < _N):
        raise ValueError("signature values out of range")
    y2 = (pow(r, 3, _P) + 7) % _P
    y = pow(y2, (_P + 1) // 4, _P)
    if y * y % _P != y2:
        raise ValueError("r is not on the curve")
    if y % 2 != v:
        y = _P - y
    z = int.from_bytes(msg_hash, "big")
    rinv = pow(r, -1, _N)
    q = _add(_mul(s * rinv % _N, (r, y)), _mul((-z * rinv) % _N, _G))
    if q is None:
        raise ValueError("no public key")
    return q


def recover_address(text: str, signature_hex: str) -> str:
    """Ethereum personal_sign recovery: the 0x address that signed `text`."""
    body = text.encode()
    prefixed = b"\x19Ethereum Signed Message:\n" + str(len(body)).encode() + body
    sig = bytes.fromhex(signature_hex[2:] if signature_hex.startswith("0x") else signature_hex)
    x, y = _recover(keccak256(prefixed), sig)
    pub = x.to_bytes(32, "big") + y.to_bytes(32, "big")
    return "0x" + keccak256(pub)[-20:].hex()


# ---------------------------------------------------------------- the check we actually make


def sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def check_signed_answer(*, request: bytes, response: bytes, model: str, signed: dict, attested: set[str]) -> list[str]:
    """Problems with a signed answer (empty list = it checks out).

    request / response: the exact bytes sent and received. signed: the /v1/signature
    answer ({text, signature, signing_address, signing_algo, signature_kind?}).
    attested: signing addresses taken from the attestation report(s).
    """
    problems = []
    req_h, resp_h = sha256_hex(request), sha256_hex(response)
    text = str(signed.get("text", ""))
    if text not in (f"{model}:{req_h}:{resp_h}", f"{req_h}:{resp_h}"):
        problems.append("signed hashes do not match the bytes we sent and received")
    if signed.get("signing_algo", "ecdsa") != "ecdsa":
        problems.append("unexpected signing algorithm")
    try:
        signer = recover_address(text, str(signed.get("signature", "")))
    except ValueError as e:
        return problems + [f"signature unreadable: {e}"]
    claimed = str(signed.get("signing_address", "")).lower()
    if signer.lower() != claimed:
        problems.append("signature was not made by the claimed signing address")
    if signer.lower() not in {a.lower() for a in attested}:
        problems.append("signer is not in the attestation report")
    return problems
