// Clear to Pay Console: the browser's crypto, bundled into docs/console/crypto.js.
// Rebuild: cd tools/console-crypto && npm ci && npm run build  (then npm test)
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { keccak_256 } from "@noble/hashes/sha3";
import { base58, base64 } from "@scure/base";
import qrcode from "qrcode-generator";

const enc = new TextEncoder();
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (h) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) || []).map((x) => parseInt(x, 16)));
export const sha256Hex = (bytes) => hex(sha256(typeof bytes === "string" ? enc.encode(bytes) : bytes));
export { base58, base64 };

/** Ethereum personal_sign recovery, as reader/ctp_reader/tee.py does it: the 0x address that signed `text`. */
export function recoverPersonalSigner(text, sigHex) {
  const body = enc.encode(text);
  const prefix = enc.encode("\x19Ethereum Signed Message:\n" + body.length);
  const msg = new Uint8Array(prefix.length + body.length);
  msg.set(prefix); msg.set(body, prefix.length);
  const sig = unhex(sigHex);
  if (sig.length !== 65) throw new Error("signature must be 65 bytes");
  let v = sig[64]; if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error("bad recovery id");
  const s = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v);
  const pub = s.recoverPublicKey(keccak_256(msg)).toRawBytes(false).slice(1);
  return "0x" + hex(keccak_256(pub).slice(-20));
}

// ---- NEAR transactions (borsh), one FunctionCall action, signed with an ed25519 key.
class W {
  constructor() { this.b = []; }
  u8(x) { this.b.push(x & 255); }
  u32(x) { for (let i = 0; i < 4; i++) this.u8(x >>> (8 * i)); }
  big(x, n) { // little-endian, n bytes; refuses (never truncates) a value that does not fit (CTP7-01)
    if (typeof x === "string" && !/^(0|[1-9]\d*)$/.test(x)) throw new Error(`not a plain whole number: ${x}`);
    let v = BigInt(x);
    if (v < 0n || v >= 1n << BigInt(8 * n)) throw new Error(`${x} does not fit in ${8 * n} bits`);
    for (let i = 0; i < n; i++) { this.u8(Number(v & 255n)); v >>= 8n; }
  }
  bytes(a) { for (const x of a) this.u8(x); }
  vec(a) { this.u32(a.length); this.bytes(a); }
  str(s) { this.vec(enc.encode(s)); }
  out() { return Uint8Array.from(this.b); }
}
export function keyFromSecret(secret) {
  const raw = base58.decode(secret.replace(/^ed25519:/, ""));
  const seed = raw.slice(0, 32);
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, publicKey: "ed25519:" + base58.encode(pub) };
}
export function signFunctionCall({ secret, signerId, receiverId, nonce, blockHash, methodName, args, gas, deposit = 0n }) {
  const k = keyFromSecret(secret);
  const w = new W();
  w.str(signerId);
  w.u8(0); w.bytes(k.pub);
  w.big(nonce, 8);
  w.str(receiverId);
  w.bytes(base58.decode(blockHash));
  w.u32(1);
  w.u8(2); // Action::FunctionCall
  w.str(methodName);
  w.vec(enc.encode(JSON.stringify(args)));
  w.big(gas, 8);
  w.big(deposit, 16);
  const tx = w.out();
  const h = sha256(tx);
  const sig = ed25519.sign(h, k.seed);
  const s = new W(); s.bytes(tx); s.u8(0); s.bytes(sig);
  return { signedB64: base64.encode(s.out()), hash: base58.encode(h), publicKey: k.publicKey };
}

// ---- Clear to Pay signed messages: the exact borsh shapes of tools/ctp-sign and src/inspection.rs.
export const INVOICE_DOMAIN = "clear-to-pay/invoice/v1";
export const DELIVERY_SIGNER_DOMAIN = "clear-to-pay/delivery/v2";
function route(w, r) { w.str(r.chain); w.str(r.token); w.str(r.address); }
function note(w, n) {
  w.str(n.order_id); w.str(n.note_id); w.u32(n.lines.length);
  for (const l of n.lines) { w.str(l.sku); w.big(l.qty, 8); }
}
/** sha-256 of borsh InvoiceMessage { domain, contract, invoice, document_hash: [u8; 32] }. */
export function invoiceDigest(contract, inv, documentHash) {
  if (!(documentHash instanceof Uint8Array) || documentHash.length !== 32) throw new Error("document hash must be 32 bytes");
  const w = new W();
  w.str(INVOICE_DOMAIN); w.str(contract);
  w.str(inv.supplier_id); w.str(inv.invoice_number); w.str(inv.order_id); w.str(inv.token);
  w.u32(inv.lines.length);
  for (const l of inv.lines) { w.str(l.sku); w.big(l.qty, 8); w.big(l.unit_price, 16); }
  w.big(inv.total, 16); route(w, inv.payee);
  w.bytes(documentHash);
  return sha256(w.out());
}
/** sha-256 of borsh DeliverySignerMessage { domain, contract, note, role, policy_version: u32 }. */
export function deliveryDigest(contract, n, role, policyVersion) {
  const w = new W();
  w.str(DELIVERY_SIGNER_DOMAIN); w.str(contract); note(w, n); w.str(role); w.u32(policyVersion);
  return sha256(w.out());
}
/** ed25519 over the 32-byte digest, base64 (as ctp-sign's sign()). */
export const signDigest = (secret, digest) => base64.encode(ed25519.sign(digest, keyFromSecret(secret).seed));
/** A new key in ctp-sign's key-file shape. */
export function newKeyFile() {
  const seed = ed25519.utils.randomPrivateKey(), pub = ed25519.getPublicKey(seed);
  const pair = new Uint8Array(64); pair.set(seed); pair.set(pub, 32);
  return { public_key: "ed25519:" + base58.encode(pub), secret_key: "ed25519:" + base58.encode(pair) };
}
/** Read a ctp-sign key file; refuses one whose halves do not match. */
export function readKeyFile(f) {
  const raw = base58.decode(String(f.secret_key || "").replace(/^ed25519:/, ""));
  if (raw.length !== 64) throw new Error("secret key must be 64 bytes");
  const k = keyFromSecret(f.secret_key);
  if (hex(k.pub) !== hex(raw.slice(32))) throw new Error("secret and public halves do not match");
  if (f.public_key && f.public_key !== k.publicKey) throw new Error("public_key does not match the secret key");
  return { public_key: k.publicKey, secret_key: f.secret_key };
}
/** The text as a QR code, as an SVG string (error correction M). */
export function qrSvg(text) {
  const q = qrcode(0, "M"); q.addData(text, "Byte"); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
/** Does `sigB64` verify for the NEAR public key over the digest? */
export function verifyDigest(publicKey, digest, sigB64) {
  try { return ed25519.verify(base64.decode(sigB64), digest, base58.decode(publicKey.replace(/^ed25519:/, ""))); } catch { return false; }
}
