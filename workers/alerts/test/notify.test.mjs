// Relay notices: a signature is announced only when it verifies and its key is registered on chain for that role or supplier;
// a request to join is announced as a request, a few an hour; and the message says what is still needed.
import assert from "node:assert/strict";
import * as C from "../../../docs/console/crypto.js";
import { encodeLink } from "../../../docs/console/links.js";
import { notice } from "../src/notify.js";

const J = "judge.cleartopay.testnet";
const kv = new Map(), KV = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) };
const store = C.newKeyFile("s.testnet"), bridge = C.newKeyFile("b.testnet"), sup = C.newKeyFile("q.testnet"), stranger = C.newKeyFile("x.testnet");
const signers = [{ key: store.public_key, role: "storekeeper" }, { key: bridge.public_key, role: "weighbridge" }];
const view = async (m, a) => m === "get_delivery_signers" ? signers : m === "get_delivery_policy" ? { required: 2, roles: [], version: 1 }
  : m === "get_supplier" ? (a.supplier_id === "qingmar-steel" ? { supplier_id: "qingmar-steel", signing_key: sup.public_key } : null) : null;
const note = { order_id: "PO-7", note_id: "DN-7", lines: [{ sku: "AH36", qty: "10" }] };
const back = (who, role, pv = 1, contract = J) => {
  const s = C.signDigest(who.secret_key, C.deliveryDigest(contract, note, role, pv));
  return `n=${encodeLink({ contract, ...note, role, policy_version: pv })}&s=${encodeURIComponent(s)}&k=${encodeURIComponent(who.public_key)}`;
};
const doc = new Uint8Array(32).fill(7);
const invoice = { supplier_id: "qingmar-steel", invoice_number: "INV-7", order_id: "PO-7", token: "usdc.testnet", lines: [{ sku: "AH36", qty: "10", unit_price: "780000" }], total: "7800000", payee: { chain: "near", token: "usdc.testnet", address: "qingmar.testnet" } };
const inv = (who) => `i=${encodeLink({ contract: J, invoice, document_hash: C.base64.encode(doc) })}&s=${encodeURIComponent(C.signDigest(who.secret_key, C.invoiceDigest(J, invoice, doc)))}&k=${encodeURIComponent(who.public_key)}`;

// nothing for a key that is not registered, a wrong role, a forged signature, an old policy or another contract
assert.equal(await notice(back(stranger, "storekeeper"), J, view, KV, "demo"), null, "unregistered key");
assert.equal(await notice(back(store, "weighbridge"), J, view, KV, "demo"), null, "registered for another role");
assert.equal(await notice(back(store, "storekeeper").replace(/&s=[^&]+/, "&s=" + encodeURIComponent(C.signDigest(stranger.secret_key, C.deliveryDigest(J, note, "storekeeper", 1)))), J, view, KV, "demo"), null, "signature does not match the key");
assert.equal(await notice(back(store, "storekeeper", 0), J, view, KV, "demo"), null, "older delivery policy");
assert.equal(await notice(back(store, "storekeeper", 1, "guard.cleartopay.testnet"), J, view, KV, "demo"), null, "another contract");
assert.equal(kv.size, 0, "nothing remembered for items that were not announced");

let m = await notice(back(store, "storekeeper"), J, view, KV, "demo");
assert.match(m, /storekeeper signed note DN-7 for order PO-7/); assert.match(m, /Checked: signature valid, key registered/);
assert.match(m, /Still needed: one more delivery role \(weighbridge\) and the supplier's signed invoice\./);
m = await notice(inv(sup), J, view, KV, "demo");
assert.match(m, /supplier qingmar-steel signed invoice INV-7/); assert.match(m, /Still needed: one more delivery role \(weighbridge\)\./);
assert.equal(await notice(inv(stranger), J, view, KV, "demo"), null, "an invoice signed by a key that is not the supplier's");
m = await notice(back(bridge, "weighbridge"), J, view, KV, "demo");
assert.match(m, /Everything is in for order PO-7/);

// requests to join: announced, but at most six an hour per contract
const req = (o) => "a=" + encodeLink({ contract: J, ...o });
m = await notice(req({ kind: "signer", key: stranger.public_key, role: "procurement" }), J, view, KV, "demo", 0);
assert.match(m, /a delivery signer \(procurement\) with key ed25519:/); assert.match(m, /Nothing is on chain yet/);
m = await notice(req({ kind: "supplier", key: sup.public_key, supplier_id: "delta-pumps", address: "delta.testnet" }), J, view, KV, "demo", 0);
assert.match(m, /supplier delta-pumps asks to be registered .* to be paid at delta\.testnet/); assert.match(m, /Call them to confirm the payout account/);
for (let i = 0; i < 4; i++) assert.ok(await notice(req({ kind: "signer", key: stranger.public_key, role: "r" + i }), J, view, KV, "demo", 0));
assert.equal(await notice(req({ kind: "signer", key: stranger.public_key, role: "r9" }), J, view, KV, "demo", 0), null, "the seventh request in an hour is not announced");
assert.ok(await notice(req({ kind: "signer", key: stranger.public_key, role: "r9" }), J, view, KV, "demo", 3600000), "the next hour, again");
for (const bad of [req({ kind: "signer", key: "ed25519:short" }), req({ kind: "admin", key: stranger.public_key }), req({ kind: "supplier", key: sup.public_key, supplier_id: "UPPER", address: "x.testnet" }), "a=%%%", "hello"])
  assert.equal(await notice(bad, J, view, KV, "demo", 7200000), null, "not announced: " + bad.slice(0, 20));
// Blind receiving: two roles that counted differently never add up to a complete note.
{
  const n9 = { order_id: "PO-9", note_id: "DN-9", lines: [{ sku: "AH36", qty: "30" }] }, n9b = { ...n9, lines: [{ sku: "AH36", qty: "29" }] };
  const sg = (who, role, nt) => `n=${encodeLink({ contract: J, ...nt, role, policy_version: 1 })}&s=${encodeURIComponent(C.signDigest(who.secret_key, C.deliveryDigest(J, nt, role, 1)))}&k=${encodeURIComponent(who.public_key)}`;
  let m1 = await notice(sg(store, "storekeeper", n9), J, view, KV, "demo");
  assert.match(m1, /\(30 AH36\)/);
  let m2 = await notice(sg(bridge, "weighbridge", n9b), J, view, KV, "demo");
  assert.match(m2, /Counts differ: storekeeper counted 30 AH36/); assert.doesNotMatch(m2, /Everything is in/); assert.match(m2, /one more delivery role/);
}
console.log("ok  relay notices: only verified, registered signatures; what is still needed; requests rate-limited; differing counts never complete a note");
