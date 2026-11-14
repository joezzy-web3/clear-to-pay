// The SDK signs exactly what the contract checks, verifies the published Judge-mode signatures, and never sends with an unfenced key.
import assert from "node:assert/strict";
import fs from "node:fs";
import * as S from "../index.js";
const here = (p) => new URL(p, import.meta.url);
assert.equal(fs.readFileSync(here("../crypto.js"), "utf8"), fs.readFileSync(here("../../docs/console/crypto.js"), "utf8"), "the SDK's crypto is the Console's build");
// real signatures from Judge mode's published cases verify; changed ones do not
const cases = JSON.parse(fs.readFileSync(here("../../docs/console/cases.json")));
const x = cases.cases[0];
for (const [i, role] of [[0, "storekeeper"], [1, "weighbridge"]].filter(([i]) => x.delivery_signatures[i])) {
  const sg = x.delivery_signatures.find((s) => S.verifyDelivery({ contract: cases.contract, note: x.delivery, role, policyVersion: 0, ...s }));
  assert.ok(sg, "a published " + role + " signature verifies");
}
const moved = structuredClone(x.delivery); moved.lines[0].qty = "2";
assert.ok(!x.delivery_signatures.some((s) => S.verifyDelivery({ contract: cases.contract, note: moved, role: "storekeeper", policyVersion: 0, ...s })), "a changed count breaks it");
assert.ok(!x.delivery_signatures.some((s) => S.verifyDelivery({ contract: "other.testnet", note: x.delivery, role: "storekeeper", policyVersion: 0, ...s })), "bound to one contract");
// round trip: supplier and delivery signing
const sup = S.newKey(), doc = new TextEncoder().encode("%PDF-1.4 invoice");
const dh = S.documentHash(doc);
const sig = S.signInvoice({ secretKey: sup.secret_key, contract: cases.contract, invoice: x.invoice, document: doc });
assert.ok(S.verifyInvoice({ publicKey: sup.public_key, contract: cases.contract, invoice: x.invoice, documentHashB64: dh, signature: sig }));
const payee = structuredClone(x.invoice); payee.payee.address = cases.attacker_payee;
assert.ok(!S.verifyInvoice({ publicKey: sup.public_key, contract: cases.contract, invoice: payee, documentHashB64: dh, signature: sig }), "a swapped payee breaks the supplier's signature");
assert.equal(S.publicKeyOf(sup.secret_key), sup.public_key);
const a = S.submitArgs({ invoice: x.invoice, supplierSignature: sig, delivery: x.delivery, deliverySignatures: x.delivery_signatures, documentHashB64: dh });
assert.deepEqual(Object.keys(a), ["invoice", "supplier_signature", "delivery", "delivery_signatures", "document_hash"]);
assert.throws(() => S.submitArgs({ invoice: x.invoice }), /all needed/);
// the key fence: a full-access key or a wider key is refused before anything is signed
const fake = (perm) => { const c = new S.ClearToPay({ contract: "judge.cleartopay.testnet" }); c.rpc = async () => ({ permission: perm, nonce: 1, block_hash: "x" }); return c; };
assert.equal((await fake("FullAccess").keyFence("a.testnet", sup.public_key)).fenced, false);
assert.equal((await fake({ FunctionCall: { receiver_id: "judge.cleartopay.testnet", method_names: ["submit_invoice", "withdraw"], allowance: "1" } }).keyFence("a", "k")).fenced, false);
assert.equal((await fake({ FunctionCall: { receiver_id: "judge.cleartopay.testnet", method_names: ["submit_invoice"], allowance: null } }).keyFence("a", "k")).fenced, false, "unlimited gas allowance");
assert.equal((await fake({ FunctionCall: { receiver_id: "judge.cleartopay.testnet", method_names: AGENT(), allowance: "250000000000000000000000" } }).keyFence("a", "k")).fenced, true);
function AGENT() { return ["submit_invoice", "execute_payment"]; }
await assert.rejects(fake("FullAccess").submitInvoice({ account: "a.testnet", secretKey: sup.secret_key, args: a }), /not fenced/);
assert.deepEqual(S.returnValue({ status: { SuccessValue: btoa(JSON.stringify({ verdict: "SEIZED" })) } }), { verdict: "SEIZED" });
assert.throws(() => new S.ClearToPay({ contract: "Not An Account" }));
assert.equal(await S.isClearToPay("bad name!"), false);
console.log("ok  sdk: signs what the contract checks, verifies Judge mode's signatures, refuses unfenced keys");
