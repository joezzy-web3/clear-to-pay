// Checks the bundled crypto against near-api-js and the saved signed reading.
import fs from "node:fs";
import assert from "node:assert/strict";
import * as C from "../../../docs/console/crypto.js";
import { transactions, utils } from "near-api-js";
import { sha256 } from "@noble/hashes/sha256";

// 1. The signed transaction is byte-identical to near-api-js.
const kp = utils.KeyPair.fromRandom("ed25519");
const secret = kp.toString();
const blockHash = utils.serialize.base_encode(new Uint8Array(32).fill(7));
const args = { receipt_id: 3, note: "ünï" };
const mine = C.signFunctionCall({ secret, signerId: "judge-buyer.cleartopay.testnet", receiverId: "judge.cleartopay.testnet",
  nonce: 123456789012n, blockHash, methodName: "execute_payment", args, gas: 300_000_000_000_000n, deposit: 0n });
const tx = transactions.createTransaction("judge-buyer.cleartopay.testnet", kp.getPublicKey(), "judge.cleartopay.testnet",
  123456789012n, [transactions.functionCall("execute_payment", args, 300_000_000_000_000n, 0n)], utils.serialize.base_decode(blockHash));
const bytes = transactions.encodeTransaction(tx);
const sig = kp.sign(sha256(bytes));
const signed = new transactions.SignedTransaction({ transaction: tx, signature: new transactions.Signature({ keyType: 0, data: sig.signature }) });
assert.equal(mine.signedB64, Buffer.from(signed.encode()).toString("base64"));
assert.equal(mine.publicKey, kp.getPublicKey().toString());
console.log("ok  transaction bytes match near-api-js");

// 2. The enclave signature on the saved reading recovers to its signing address.
const r = JSON.parse(fs.readFileSync(new URL("../../../docs/proof/reading-INV-2208.json", import.meta.url)));
assert.equal(C.sha256Hex(r.request), r.evidence.request_sha256);
assert.equal(C.sha256Hex(r.response), r.evidence.response_sha256);
assert.equal(C.recoverPersonalSigner(r.evidence.signature.text, r.evidence.signature.signature), r.evidence.signature.signing_address.toLowerCase());
console.log("ok  reading signature recovers to", r.evidence.signature.signing_address);

// 3. Golden digests: the same fixed messages as src/vector_tests.rs and ctp-sign's tests.
const route = { chain: "near", token: "usdc.testnet", address: "qingmar.testnet" };
const goldenInvoice = { supplier_id: "qingmar-steel", invoice_number: "INV-2208", order_id: "PO-1184", token: "usdc.testnet",
  lines: [{ sku: "AH36-12mm", qty: "10", unit_price: "780000" }], total: "7800000", payee: route };
const dn552 = { order_id: "PO-1184", note_id: "DN-552", lines: [{ sku: "AH36-12mm", qty: "10" }] };
assert.equal(C.hex(C.deliveryDigest("cleartopay.testnet", dn552, "weighbridge", 1)), "89ae0c5228cc3a8d098d5ec0d955aeb064a33d14cd52617f739f67dc62779c91");
assert.equal(C.hex(C.invoiceDigest("cleartopay.testnet", goldenInvoice, new Uint8Array(32).fill(7))), "c32c1956cb24e02607430a2de0fddc3ee69c97d5c055f7f8991561996784c64f");
console.log("ok  golden digests (delivery v2, invoice v1) match the contract");

// 4. Byte for byte what ctp-sign signed, with the same throwaway keys.
const fx = JSON.parse(fs.readFileSync(new URL("./ctp-sign-fixture.json", import.meta.url)));
const keyOf = (seedHex) => {
  const seed = C.unhex(seedHex), pub = C.keyFromSecret("ed25519:" + C.base58.encode(new Uint8Array([...seed, ...new Uint8Array(32)]))).pub;
  return C.readKeyFile({ secret_key: "ed25519:" + C.base58.encode(new Uint8Array([...seed, ...pub])) });
};
const out = fx.ctp_sign_output;
const sup = keyOf(fx.seeds_hex.supplier);
const docHash = C.base64.decode(out.document_hash);
assert.equal(C.signDigest(sup.secret_key, C.invoiceDigest(fx.contract, out.invoice, docHash)), out.supplier_signature);
for (const role of ["storekeeper", "weighbridge"]) {
  const k = keyOf(fx.seeds_hex[role]);
  const s = out.delivery_signatures.find((x) => x.key === k.public_key);
  assert.ok(s, "fixture has a " + role + " signature");
  assert.equal(C.signDigest(k.secret_key, C.deliveryDigest(fx.contract, out.delivery, role, fx.policy_version)), s.signature);
  assert.notEqual(C.signDigest(k.secret_key, C.deliveryDigest(fx.contract, out.delivery, role === "weighbridge" ? "storekeeper" : "weighbridge", fx.policy_version)), s.signature);
  assert.notEqual(C.signDigest(k.secret_key, C.deliveryDigest(fx.contract, out.delivery, role, fx.policy_version + 1)), s.signature);
}
console.log("ok  invoice and delivery signatures are byte-for-byte what ctp-sign made; another role or policy version gives a different one");

// 5. Key files: a new key reads back; a mismatched one is refused.
const nk = C.newKeyFile();
assert.deepEqual(C.readKeyFile(nk), nk);
assert.throws(() => C.readKeyFile({ ...nk, public_key: C.newKeyFile().public_key }));
assert.match(C.qrSvg("https://clear-to-pay.vercel.app/console/sign/#n=x"), /^<svg/);
const vd = C.deliveryDigest("cleartopay.testnet", dn552, "weighbridge", 1);
assert.ok(C.verifyDigest(nk.public_key, vd, C.signDigest(nk.secret_key, vd)));
assert.ok(!C.verifyDigest(nk.public_key, C.deliveryDigest("cleartopay.testnet", dn552, "storekeeper", 1), C.signDigest(nk.secret_key, vd)));
console.log("ok  key files, verification and QR");

// 6. CTP7-01: integers are encoded at their exact width or refused, never truncated.
const nq = (qty) => ({ order_id: "PO-1184", note_id: "DN-552", lines: [{ sku: "AH36-12mm", qty }] });
const iv = (unit_price, total) => ({ ...goldenInvoice, lines: [{ sku: "AH36-12mm", qty: "10", unit_price }], total });
assert.doesNotThrow(() => C.deliveryDigest("cleartopay.testnet", nq("18446744073709551615"), "weighbridge", 1)); // u64 max
for (const bad of ["18446744073709551616", "-1", "1e3", "010", "1.5", " 10"]) assert.throws(() => C.deliveryDigest("cleartopay.testnet", nq(bad), "weighbridge", 1), undefined, bad);
const U128 = "340282366920938463463374607431768211455";
assert.doesNotThrow(() => C.invoiceDigest("cleartopay.testnet", iv(U128, U128), new Uint8Array(32)));
assert.throws(() => C.invoiceDigest("cleartopay.testnet", iv("340282366920938463463374607431768211456", "1"), new Uint8Array(32)));
assert.throws(() => C.invoiceDigest("cleartopay.testnet", iv("1", "340282366920938463463374607431768211456"), new Uint8Array(32)));
console.log("ok  u64/u128 at their exact width: max accepted; max+1, negatives, exponents, leading zeros refused");

// 7. NEP-413: our digest and verification agree with NEAR Wallet Selector's reference verifier.
const { verifySignature } = await import("@near-wallet-selector/core");
const acct = C.newKeyFile(), nonce = new Uint8Array(32).map((_, i) => i * 7 + 1);
const text = C.payoutProofText({ address: "acme.testnet", supplier_id: "acme-steel", contract: "judge.cleartopay.testnet", key: nk.public_key, at: "2026-11-07T08:00:00Z" });
const sig413 = C.signDigest(acct.secret_key, C.nep413Digest({ message: text, nonce, recipient: "judge.cleartopay.testnet" }));
assert.ok(verifySignature({ publicKey: acct.public_key, signature: sig413, message: text, nonce: Buffer.from(nonce), recipient: "judge.cleartopay.testnet" }), "the reference verifier accepts our signature");
assert.ok(C.verifyNep413({ publicKey: acct.public_key, signature: sig413, message: text, nonce, recipient: "judge.cleartopay.testnet" }));
assert.ok(!C.verifyNep413({ publicKey: acct.public_key, signature: sig413, message: text.replace("acme.testnet", "evil.testnet"), nonce, recipient: "judge.cleartopay.testnet" }));
assert.ok(!C.verifyNep413({ publicKey: acct.public_key, signature: sig413, message: text, nonce, recipient: "guard.cleartopay.testnet" }));
const sigCb = C.signDigest(acct.secret_key, C.nep413Digest({ message: text, nonce, recipient: "r", callbackUrl: "https://x/cb" }));
assert.ok(verifySignature({ publicKey: acct.public_key, signature: sigCb, message: text, nonce: Buffer.from(nonce), recipient: "r", callbackUrl: "https://x/cb" }), "with a callback URL too");
console.log("ok  NEP-413 matches the wallet selector's reference verifier; another address or recipient fails");
