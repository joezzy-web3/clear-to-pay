// The invoice flow in the browser (docs/console/invoice-flow.js), checked offline:
// the supplier's invoice is built only from the order and the address on file, the AI's real
// signed reading of the clean sample matches it, a poisoned or edited one does not, and the
// submit call carries exactly the signed bytes. node test/flow.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const F = await import("../../../docs/console/invoice-flow.js");
const V = await import("../../../docs/console/outlayer-verify.js");
const C = await import("../src/index.js");
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

const order = { supplier_id: "qingmar-steel", token: USDC, lines: [{ sku: "AH36-12mm", qty: "100", unit_price: "780000" }, { sku: "BOLT-M20", qty: "40", unit_price: "1500000" }], invoiced: ["90", "0"] };
const route = { chain: "near", token: USDC, address: "qingmar.cleartopay.testnet" };
const base = { supplier_id: "qingmar-steel", invoice_number: "INV-2208", order_id: "PO-1184", order, route };

// built from the order: price from chain, payee from the address on file, empty lines skipped
const inv = F.buildInvoice({ ...base, qtys: { "AH36-12mm": "10", "BOLT-M20": "" } });
assert.deepEqual(inv, { supplier_id: "qingmar-steel", invoice_number: "INV-2208", order_id: "PO-1184", token: USDC,
  lines: [{ sku: "AH36-12mm", qty: "10", unit_price: "780000" }], total: "7800000", payee: route });
// the total is the contract's own sum (qty x unit price), so it can never be total_mismatch
assert.equal(F.buildInvoice({ ...base, qtys: { "AH36-12mm": "3", "BOLT-M20": "2" } }).total, String(3 * 780000 + 2 * 1500000));

// refusals
const no = (q, re, extra = {}) => assert.throws(() => F.buildInvoice({ ...base, ...extra, qtys: q }), re);
no({ "AH36-12mm": "11" }, /only 10 left/);                              // over what is left on the order
no({ "AH36-12mm": "2.5" }, /whole number/);
no({ "AH36-12mm": "-1" }, /whole number/);
no({}, /at least one line/);
no({ "AH36-12mm": "1" }, /not for your company/, { supplier_id: "someone-else" });
no({ "AH36-12mm": "1" }, /invoice number/, { invoice_number: "INV 22" });
no({ "AH36-12mm": "1" }, /no payout address/, { route: null });
// a quantity box cannot carry a different price or payee: unknown keys are ignored
assert.deepEqual(F.buildInvoice({ ...base, qtys: { "AH36-12mm": "1", unit_price: "1", payee: "x.testnet" } }).lines, [{ sku: "AH36-12mm", qty: "1", unit_price: "780000" }]);

// the supplier's signature over the built invoice verifies the way the contract checks it (check.mjs ties invoiceDigest to Rust)
const k = C.newKeyFile(), doc = new Uint8Array(32).fill(7);
const sig = C.signDigest(k.secret_key, C.invoiceDigest("judge.cleartopay.testnet", inv, doc));
assert.ok(C.verifyDigest(k.public_key, C.invoiceDigest("judge.cleartopay.testnet", inv, doc), sig));
assert.ok(!C.verifyDigest(k.public_key, C.invoiceDigest("judge.cleartopay.testnet", { ...inv, payee: { ...route, address: "evil.testnet" } }, doc), sig), "a changed payee breaks it");

// the AI's REAL signed reading of the clean sample (docs/proof/outlayer) against what the supplier signed
const proof = JSON.parse(fs.readFileSync(new URL("../../../docs/proof/outlayer/onchain-01-clean.json", import.meta.url))).output;
const e = JSON.parse(proof.reading).extraction;
const all = F.compareReading(e, inv);
assert.ok(all.every((c) => c.ok), "the clean sample's reading matches: " + JSON.stringify(all.filter((c) => !c.ok)));
const edited = { ...inv, total: "9800000", lines: [{ ...inv.lines[0], qty: "12" }] };
const bad = F.compareReading(e, edited).filter((c) => !c.ok).map((c) => c.label);
assert.deepEqual(bad, ["Total", "Line AH36-12mm"], "a signed invoice that differs from the PDF is flagged field by field");
assert.equal(F.compareReading(null, inv)[0].ok, false);
assert.ok(F.compareReading({ ...e, total: "7,80" }, inv).find((c) => c.label === "Total").ok === false, "a comma is not a decimal point");
assert.ok(F.compareReading({ ...e, total: "7.800000" }, inv).find((c) => c.label === "Total").ok, "trailing zeros are the same amount");
assert.ok(F.compareReading({ ...e, lines: [...e.lines, { sku: "EXTRA", qty: "1", unit_price: "1" }] }, inv).some((c) => !c.ok && /did not sign/.test(c.label)));

// pairing and the submit call: exactly the signed objects, nothing added
const note = { note: { order_id: "PO-1184", note_id: "DN-0412", lines: [{ sku: "AH36-12mm", qty: "10" }] }, roles: ["storekeeper", "weighbridge"],
  signatures: [{ key: "ed25519:A", signature: "s1", role: "storekeeper" }, { key: "ed25519:B", signature: "s2", role: "weighbridge" }] };
const signed = { invoice: inv, signature: sig, document_hash: C.base64.encode(doc) };
assert.equal(F.pairs([signed], [note, { ...note, note: { ...note.note, order_id: "PO-9" } }])[0].notes.length, 1, "only the note for the same order");
assert.deepEqual(F.submitArgs(signed, note), { invoice: inv, supplier_signature: sig, delivery: note.note,
  delivery_signatures: [{ key: "ed25519:A", signature: "s1" }, { key: "ed25519:B", signature: "s2" }], document_hash: C.base64.encode(doc) });

console.log("flow: ok (invoice built from the order, the real reading matches, edits are flagged, submit carries the signed bytes)");
