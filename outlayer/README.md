# The reader inside OutLayer (spike, branch `outlayer`)

Clear to Pay's invoice reader as an [OutLayer](https://github.com/fastnear/near-outlayer) WASI P2
component. The NEAR AI key lives as an encrypted author secret, decrypted only inside the
enclave (Intel TDX). Each reading is signed by an ed25519 key derived inside the enclave, so a
static page can offer "Read my invoice" with no server of ours.

**What does not change:** the AI decides nothing, and there is no payee field. The contract pays
only the supplier's registered address. OutLayer only makes the *reading* reachable from a browser.

## What it does
- Input: `{ "document_text", "document_sha256" }`, the text the browser's scan already checked.
- It sends **the same prompt v3** (`PROMPT_SHA 11e8da92139223cd`) to **the same pinned model**
  (`Qwen/Qwen3.6-35B-A3B-FP8`), **byte for byte** what `reader/ctp_reader/model.py` sends.
- It checks NEAR AI's answer as the Python reader does:
  - sha256 of the exact request and response bytes;
  - secp256k1 signer recovery;
  - the signer must be in an attestation report that carries our fresh nonce, bound in the
    Intel TDX quote's REPORTDATA;
  - the served model must be the pinned one.
- It validates the answer strictly, as `schema.py` does: exactly 7 fields, no payee, exact
  money, and the total must add up.
- It returns `reading`, an exact JSON string, plus `signature` over
  `clear-to-pay/reading/v1:<sha256(reading)>`, signed with the enclave key `readings`. It also
  returns the raw NEAR AI bytes, so anyone can re-check that signature.
- A failed check is signed too, honestly: `nearai_signature_ok: false`, held.

## What it does not do
- **Check the hardware itself:** the Intel signature chain over the quote and NVIDIA's GPU
  verdict. Those stay in the CLI reader (`ctp-read`). OutLayer attests *our* code; our code
  checks NEAR AI's signature.

## Step 0 (answered 7 Nov from OutLayer's source; CORS checked live)
1. **Network:** yes. `wasi:http` on P2. `capabilities.network` is an exact-host allowlist, here
   `cloud-api.near.ai` with a 120 s timeout.
2. **Secrets:** yes. Set `"author_secrets": {"profile": "author"}` in the embedded manifest, and
   store `NEARAI_API_KEY` under our account for this project with AllowAll. It reaches the code
   as an environment variable on every run, and callers never see it. Every public call spends
   our NEAR AI credit, so the key is a new one with a small cap.
3. **Browser:** yes.
   - `POST https://testnet-api.outlayer.ai/call/<owner>/<project>` with `X-Payment-Key` from any
     page (`access-control-allow-origin: *`, checked 7 Nov).
   - A payment key's balance is its cap; `X-Compute-Limit` caps one run.
   - A key can't be limited to one project, so the published key is funded small.

## Build and test
- `cargo test`: 13 tests.
  - Prompt and request bytes against Python vectors.
  - The live reading in `docs/proof/` verifies here too, and fails with one byte changed or a
    foreign nonce.
  - A fake NEAR AI for a whole run: tampered, stale or swapped answers, a payee field, a total
    that doesn't add up, bad input.
- CI (`.github/workflows/outlayer.yml`):
  - builds `wasm32-wasip2` twice; the sha256 must match;
  - runs it on wasmtime 28 (OutLayer's worker version) through `harness/`;
  - with the `NEARAI_SPIKE_KEY` secret, reads the clean sample live through the built component.
- A tag `outlayer-v*` publishes the wasm and its sha256 as a release. OutLayer fetches the
  wasm from that URL, because testnet FastFS has been unreliable (out-layer/outlayer#32).
