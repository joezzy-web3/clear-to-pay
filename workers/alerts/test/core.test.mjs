// The worker's alert logic: the same cases as reader/tests/test_alerts.py, plus who hears what.
import assert from "node:assert/strict";
import { changes, parseStart, recipients, b64u, snapshot, usdc } from "../src/core.js";

const base = () => ({ receipts: {}, payments: {}, signers: { "ed25519:A": "storekeeper" }, funds: { available: "15000000", reserved: "0" },
  suppliers: { "qingmar-steel": { route: "qingmar.cleartopay.testnet", payable_from: "1", nonce: "0", pending: null } } });
const clone = (o) => JSON.parse(JSON.stringify(o));

// 1. Nothing changed: nothing sent
assert.deepEqual(changes(base(), base()), []);

// 2. A proposed address change is an ALARM for the buyer and that supplier, and says when it could be paid
let now = clone(base()); now.suppliers["qingmar-steel"].nonce = "1";
now.suppliers["qingmar-steel"].pending = { route: "qingmar-payments.testnet", proposed_at: "1793900000000000000", approved: false };
let a = changes(base(), now);
assert.equal(a.length, 1); assert.equal(a[0].level, "ALARM"); assert.match(a[0].text, /PROPOSED.*qingmar-payments\.testnet.*Earliest/);
assert.deepEqual(a[0].to, ["buyer", "supplier:qingmar-steel"]);

// 3. Proposed and cancelled between two checks: the nonce gives it away
now = clone(base()); now.suppliers["qingmar-steel"].nonce = "2";
a = changes(base(), now); assert.equal(a.length, 1); assert.match(a[0].text, /between checks/);

// 4. A new delivery signer: buyer and signers; a SEIZED invoice: buyer and that supplier, with "do not reply"
now = clone(base()); now.signers["ed25519:B"] = "weighbridge";
now.receipts["0"] = { verdict: "Seized", reasons: ["payee_mismatch"], invoice_number: "INV-2210", supplier_id: "qingmar-steel", amount: "7800000", order_id: "PO-1184" };
a = changes(base(), now);
assert.equal(a.length, 2); assert.ok(a.every((x) => x.level === "ALARM"));
assert.deepEqual(a.find((x) => /signer ADDED/.test(x.text)).to, ["buyer", "signers"]);
assert.match(a.find((x) => /SEIZED/.test(x.text)).text, /Do not reply/);

// 5. HELD lists the buyer's steps; PAID reaches the supplier too; a deposit is buyer-only
now = clone(base());
now.receipts["1"] = { verdict: "Held", reasons: ["delivery_signatures_missing"], invoice_number: "INV-2208", supplier_id: "qingmar-steel", amount: "7800000" };
now.receipts["2"] = { verdict: "Cleared", reasons: [], invoice_number: "INV-2208", supplier_id: "qingmar-steel", amount: "7800000" };
now.payments["2"] = { status: "Settled", amount: "7800000", attempt: 1, to: "qingmar.cleartopay.testnet" };
now.funds = { available: "20000000", reserved: "0" };
a = changes(base(), now);
assert.match(a.find((x) => /HELD/.test(x.text)).text, /missing signer/);
assert.deepEqual(a.find((x) => /PAID/.test(x.text)).to, ["buyer", "supplier:qingmar-steel"]);
assert.deepEqual(a.find((x) => /Deposit/.test(x.text)).to, ["buyer"]);
// 6. Money out that no payment explains is an ALARM
now = clone(base()); now.funds = { available: "5000000", reserved: "0" };
a = changes(base(), now); assert.equal(a[0].level, "ALARM"); assert.match(a[0].text, /Pool down 10\.00/);

// 7. Subscriptions: links parse strictly; a supplier hears only its own supplier's news
const nets = { demo: "judge.cleartopay.testnet", live: "guard.cleartopay.testnet" };
assert.deepEqual(parseStart("demo_b", nets), { net: "demo", role: "buyer" });
assert.deepEqual(parseStart("live_s_" + b64u("qingmar-steel"), nets), { net: "live", role: "supplier:qingmar-steel" });
for (const bad of ["demo", "x_b", "demo_s_" + b64u("Bad Id!"), "demo_b_extra", "demo_s_%%%"]) assert.equal(parseStart(bad, nets), null, bad);
const subs = { "1": { roles: ["buyer"] }, "2": { roles: ["supplier:qingmar-steel"] }, "3": { roles: ["supplier:other"] }, "4": { roles: ["signers"] } };
assert.deepEqual(recipients({ to: ["buyer", "supplier:qingmar-steel"] }, subs), ["1", "2"]);
assert.deepEqual(recipients({ to: ["buyer", "signers"] }, subs), ["1", "4"]);

// 8. snapshot: reads new receipts once, and follows unfinished payments
const calls = [];
const view = async (m, a) => { calls.push(m); return ({ get_supplier_ids: ["qingmar-steel"], receipt_count: 1,
  get_receipt: { verdict: "Cleared", reasons: [], invoice_number: "INV-1", supplier_id: "qingmar-steel", amount: "780000", order_id: "PO-J1" },
  get_payment: { status: "Submitted", amount: "780000", attempt: 1, recipient: { address: "qingmar.cleartopay.testnet" } },
  get_supplier: { route_on_file: { address: "qingmar.cleartopay.testnet" }, route_payable_from: "1", last_nonce: 0, pending: null },
  get_delivery_signers: [], get_funds: { available: "1", reserved: "0" } })[m]; };
const s1 = await snapshot(view, "usdc"); const s2 = await snapshot(view, "usdc", s1);
assert.equal(calls.filter((c) => c === "get_receipt").length, 1); assert.equal(calls.filter((c) => c === "get_payment").length, 2);
assert.equal(usdc("780000"), "0.78"); assert.equal(usdc("1"), "0.000001");
// 9. CTP7-04: a receipt the server says does not exist does not stall the cursor, and the buyer is told
let n9 = 0;
const view9 = async (m, a) => ({ get_supplier_ids: [], receipt_count: 3, get_receipt: a.receipt_id === 1 ? null : { verdict: "Held", reasons: [], invoice_number: "INV-" + a.receipt_id, supplier_id: "s", amount: "1", order_id: "PO" },
  get_delivery_signers: [], get_funds: { available: "0", reserved: "0" } })[m] ?? (m === "get_receipt" ? null : undefined);
const t1 = await snapshot(view9, "usdc");
assert.deepEqual(Object.keys(t1.receipts), ["0", "1", "2"]); assert.equal(t1.receipts["1"].verdict, "Unreadable");
const a9 = changes({ ...t1, receipts: {} }, t1);
assert.ok(a9.some((x) => x.level === "ALARM" && /Receipt #1 could not be read/.test(x.text) && x.to.includes("buyer")));
console.log("ok  alert worker: 9 groups of checks pass");
