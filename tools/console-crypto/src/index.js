// Clear to Pay Console: the browser's crypto, bundled into docs/console/crypto.js.
// Rebuild: cd tools/console-crypto && npm ci && npm run build  (then npm test)
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { keccak_256 } from "@noble/hashes/sha3";
import { base58, base64 } from "@scure/base";

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
  big(x, n) { let v = BigInt(x); for (let i = 0; i < n; i++) { this.u8(Number(v & 255n)); v >>= 8n; } }
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
