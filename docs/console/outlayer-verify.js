// Clear to Pay: checking a reading that came back from the reader inside OutLayer's TEE.
// Pure functions (no page, no network): Judge mode uses them, and so does the offline test
// tools/console-crypto/test/outlayer.mjs against the proof files in docs/proof/outlayer/.
import * as C from "./crypto.js";

/** The published reader. Every value here can be checked: the WASM sha256 is the reproducible
 *  build (CI builds it twice), the enclave key is printed by {"op":"public_key"} inside the TEE. */
export const READER = {
  api: "https://testnet-api.outlayer.ai",
  project: "cleartopay-reader.testnet/reader",
  wasm: "e11834078a135e4ff98df8e52f3dbba934f5b499fe3a43a20e29788b2d96c66d",
  release: "https://github.com/joezzy-web3/clear-to-pay/releases/tag/outlayer-v0.1.0",
  enclaveKey: "51d8788daae1aa4d55897b426d66810764efd6e0eb883157805ed87394f74d83",
  promptSha: "11e8da92139223cd",
  model: "Qwen/Qwen3.6-35B-A3B-FP8",
  // PUBLIC on purpose: a payment key that pays ONLY for this project and holds a few test dollars.
  // Anyone can spend it on our reader; nobody can spend it on anything else.
  paymentKey: "cleartopay-reader.testnet:1:99ffaf24cabe1400af450432b3d3c6418ae82854dce9ffb54f2e57beeb5aafa9",
};
export const SIGN_PREFIX = "clear-to-pay/reading/v1:";

const enc = new TextEncoder();
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b) => btoa(String.fromCharCode(...b));
const i64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(n), true); return b; };
const cat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };

/** The reading's own checks: the enclave's signature, and that it is a reading of THIS file by THIS prompt. */
export function checkReading(output, documentSha256) {
  const out = [];
  const add = (ok, label, detail) => out.push({ ok: !!ok, label, detail });
  let r = null;
  try { r = JSON.parse(output.reading); } catch {}
  const msg = SIGN_PREFIX + C.sha256Hex(output.reading || "");
  const sigOk = !!r && output.signed_message === msg && output.public_key === READER.enclaveKey &&
    C.verifyDigest("ed25519:" + C.base58.encode(C.unhex(READER.enclaveKey)), enc.encode(msg), bytesToB64(C.unhex(output.signature || "")));
  add(sigOk, "The enclave signed this reading", "ed25519 key " + READER.enclaveKey.slice(0, 12) + "…, derived inside the TEE");
  add(r && r.document_sha256 === documentSha256, "It is a reading of this file", "document_sha256 = sha-256 of the PDF in this browser");
  add(r && r.prompt_sha === READER.promptSha && r.model === READER.model, "Same prompt, same pinned model as the CLI reader", `prompt ${READER.promptSha} · ${READER.model}`);
  // NEAR AI's own signature, re-checked here from the exact bytes the enclave sent and received
  const n = output.nearai || {}, s = n.signature || {};
  const want = `${READER.model}:${C.sha256Hex(n.request || "")}:${C.sha256Hex(n.response || "")}`;
  let signer = ""; try { signer = C.recoverPersonalSigner(s.text || "", s.signature || ""); } catch {}
  const nearOk = !!r && r.nearai_signature_ok === true && s.text === want && signer && signer === String(s.signing_address).toLowerCase() &&
    r.model_signers.includes(signer) && r.request_sha256 === C.sha256Hex(n.request) && r.response_sha256 === C.sha256Hex(n.response);
  add(nearOk, "NEAR AI's enclave signed the AI's answer", signer ? "signer " + signer.slice(0, 12) + "…, bound to our fresh nonce in its TDX quote (checked in the enclave)" : "no signature");
  return { reading: r, checks: out };
}

/** OutLayer's attestation for the call: our exact WASM ran, it produced exactly this output,
 *  and the Intel TDX quote's REPORTDATA commits to both. */
export function checkAttestation(att, output) {
  const out = [];
  const add = (ok, label, detail) => out.push({ ok: !!ok, label, detail });
  add(att && att.executed_wasm_sha256 === READER.wasm && att.wasm_hash === READER.wasm && att.project_id === READER.project,
    "OutLayer ran our published code", "WASM sha256 " + READER.wasm.slice(0, 12) + "… (the reproducible build)");
  add(att && att.output_hash === C.sha256Hex(JSON.stringify(output)), "…and it produced exactly this output", "sha-256 of the output = the attestation's output_hash");
  let bound = false;
  try {
    const q = b64ToBytes(att.tdx_quote);
    const f = [enc.encode(att.task_type), i64le(att.task_id)];
    for (const k of ["repo", "commit", "build_target", "wasm_hash", "input_hash"]) if (att[k] != null) f.push(enc.encode(att[k]));
    f.push(enc.encode(att.output_hash));
    if (att.block_height != null) f.push(i64le(att.block_height));
    for (const k of ["caller_account_id", "project_id", "secrets_ref"]) if (att[k] != null) f.push(enc.encode(att[k]));
    f.push(i64le(att.timestamp));
    if (att.attached_usd != null) f.push(enc.encode(att.attached_usd));
    const rd = q.slice(568, 632);
    bound = q[0] === 4 && q[1] === 0 && C.hex(rd.slice(0, 32)) === C.sha256Hex(cat(f)) && rd.slice(32).every((x) => x === 0);
  } catch {}
  add(bound, "The Intel TDX quote commits to both", "REPORTDATA = sha-256 of the task: code hash, output hash, project, time");
  return out;
}

// ---- the invoice in the browser: text that a person can see, and text they cannot

/** Same rule as reader/ctp_reader/intake.py: hidden text that talks about payment holds the invoice. */
export const PAYMENT_WORDS = /pay|wallet|account|acct|bank|iban|swift|bic|routing|sort\s*code|transfer|remit|beneficiar|usdc|usdt|address|amount|invoice|total|\.near\b|\.testnet\b|0x[0-9a-f]{6,}|\d{4,}/i;
