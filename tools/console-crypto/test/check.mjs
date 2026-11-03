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
