// The New order wizard: exactly which owner calls go into the one transaction, and what it refuses (and at which step).
// the wizard's plan(): what it puts in the transaction, and what it refuses
import assert from "node:assert/strict";
globalThis.document = { getElementById: () => null };
const W = await import(new URL("../../../docs/console/setup/order.js", import.meta.url));
const k = (c) => "ed25519:" + c.repeat(44);
const X = { suppliers: [{ id: "qingmar-steel", key: k("Q"), addr: "qingmar.cleartopay.testnet", payable: true, from: 1 }],
  signers: [{ key: k("S"), role: "storekeeper" }], limits: { per_invoice: "7800000", per_supplier_per_period: "50000000", period_hours: "24", max_submissions_per_day: 200 } };
const D = { sup: { mode: "new", id: "acme-steel", key: k("A"), addr: "acme.testnet", calledFor: `acme.testnet|${k("A")}` },
  po: { id: "PO-9001", lines: [{ sku: "AH36-12mm", qty: "30", price: "0.78" }, { sku: "BOLT-M20", qty: "500", price: "0.012" }] },
  sig: { pick: [k("S")], add: [{ key: k("W"), role: "weighbridge" }] }, lim: { inv: "7.8", per: "50", hours: "24", max: "200" } };
const p = W.plan(D, X, "judge.cleartopay.testnet");
assert.deepEqual(p.actions.map((a) => a[0]), ["register_supplier", "add_delivery_signer", "create_order", "set_delivery_policy"]);
assert.equal(p.total, (30n * 780000n + 500n * 12000n).toString());
assert.deepEqual(p.actions[2][1].lines[1], { sku: "BOLT-M20", qty: "500", unit_price: "12000" });
assert.deepEqual(p.actions[3][1], { order_id: "PO-9001", required: 2, roles: ["storekeeper", "weighbridge"] });
assert.equal(p.limits.changed, false); assert.equal(p.tgas, 20 + 15 + 60 + 15);
const wa = W.walletActions(p); assert.ok(wa.every((a) => a.params.deposit === "1" && a.type === "FunctionCall"));
assert.equal(wa.reduce((t, a) => t + BigInt(a.params.gas), 0n), 110n * 10n ** 12n);
const bad = (patch, step, re) => { const d = structuredClone(D); patch(d); try { W.plan(d, X, "c"); assert.fail("accepted"); } catch (e) { assert.equal(e.step, step, e.message); assert.match(e.message, re); } };
bad((d) => (d.sup.calledFor = ""), 1, /called/);
bad((d) => (d.sup.addr = "other.testnet"), 1, /called/);           // changing the address clears the phone-call tick
bad((d) => (d.sup.key = k("S")), 1, /delivery signer/);
bad((d) => (d.sup.id = "qingmar-steel"), 1, /already registered/);
bad((d) => (d.po.lines[0].qty = "1e3"), 2, /quantity/);
bad((d) => (d.po.lines[0].price = "0.0000001"), 2, /price/);
bad((d) => (d.po.lines[1].sku = "AH36-12mm"), 2, /two lines/);
bad((d) => (d.po.lines[0].qty = "18446744073709551616"), 2, /quantity/);
bad((d) => (d.sig.add = []), 3, /two different roles/);
bad((d) => (d.sig.add[0].role = "storekeeper"), 3, /two different roles/);
bad((d) => (d.sig.add[0].key = k("A")), 3, /supplier/);
bad((d) => (d.lim.inv = "60"), 4, /cannot be above/);
const d2 = structuredClone(D); d2.lim.inv = "10"; const p2 = W.plan(d2, X, "c");
assert.equal(p2.actions.at(-1)[0], "set_limits"); assert.deepEqual(p2.actions.at(-1)[1], { per_invoice: "10000000", per_supplier_per_period: "50000000", period_hours: "24", max_submissions_per_day: 200 });
const d3 = structuredClone(D); d3.sup = { mode: "existing", id: "qingmar-steel" }; assert.equal(W.plan(d3, X, "c").actions[0][0], "add_delivery_signer");
console.log("ok  wizard plan: actions, order, units, policy, limits only when changed; 12 refusals at the right step");
