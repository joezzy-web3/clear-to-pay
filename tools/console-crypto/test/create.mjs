// Creating a buyer's own contract from the browser (docs/console/create.js), checked offline: the name, the factory
// check, the exact transaction the wallet is asked to sign, reading the factory's verdict, and the read-back.
// node test/create.mjs
import assert from "node:assert/strict";
const C = await import("../../../docs/console/create.js");

// names: always one level under the factory, whatever account the buyer uses
assert.equal(C.FACTORY, "factory.cleartopay.testnet");
assert.equal(C.contractName("acme"), "acme.factory.cleartopay.testnet");
assert.equal(C.contractName("acme-foods_2"), "acme-foods_2.factory.cleartopay.testnet");
assert.ok(C.contractName("x".repeat(32)).length <= 64);
for (const l of ["Acme", "a", "", "acme.foods", "ac--me", "-acme", "acme-", "ac me", "x".repeat(33), null, 5])
  assert.throws(() => C.contractName(l), /lowercase/, String(l));
for (const l of C.RESERVED) assert.throws(() => C.contractName(l), /reserved/, l);
assert.ok(C.RESERVED.every(C.isLabel));

// the factory must report our code before anything is sent
assert.equal(C.CODE_SHA256.length, 64);
assert.match(C.CODE_HASH_B58, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
assert.equal(C.checkFactory(C.CODE_SHA256), true);
for (const h of ["", null, "0".repeat(64), C.CODE_SHA256.toUpperCase()]) assert.throws(() => C.checkFactory(h), /expected code/);

// the transaction: one ordinary call, no deploy, no key
const tx = C.createTx({ buyer: "acme.testnet", label: "acme" });
assert.deepEqual(tx, { receiverId: "factory.cleartopay.testnet", actions: [
  { type: "FunctionCall", params: { methodName: "create", args: { label: "acme" }, gas: "300000000000000", deposit: "3600000000000000000000000" } }] });
assert.equal(BigInt(C.FUND), BigInt(Math.round(Number(C.FUND_NEAR) * 1e6)) * 10n ** 18n);
assert.ok(BigInt(C.FUND) > BigInt(332903) * 10n ** 19n, "covers the code's storage");
assert.ok(BigInt(C.FUND) <= 5n * 10n ** 24n, "within the factory's cap");
// implicit buyers work too: they no longer create sub-accounts themselves
assert.equal(C.createTx({ buyer: "a".repeat(64), label: "acme" }).receiverId, C.FACTORY);
assert.throws(() => C.createTx({ buyer: "", label: "acme" }), /Connect a wallet/);
assert.throws(() => C.createTx({ buyer: "acme.testnet", label: "Acme" }), /lowercase/);

// the factory's verdict, read from the wallet's outcome; only the factory's own events count
const ev = (event) => "EVENT_JSON:" + JSON.stringify({ standard: "cleartopay-factory", version: "0.1.0", event, data: [{}] });
const out = (...rs) => ({ status: { SuccessValue: "" }, receipts_outcome: rs.map(([who, logs, status]) => ({ outcome: { executor_id: who, logs, status: status || { SuccessValue: "" } } })) });
assert.equal(C.createOutcome(out([C.FACTORY, [ev("create_started")]], [C.FACTORY, [ev("contract_created")]])), "created");
assert.equal(C.createOutcome(out([C.FACTORY, [ev("create_started")]], [C.FACTORY, [ev("create_failed_refunded")]])), "refunded");
assert.equal(C.createOutcome([out([C.FACTORY, [ev("contract_created")]])]), "created"); // some wallets return an array
assert.equal(C.createOutcome(out(["evil.testnet", [ev("contract_created")]])), "unknown"); // someone else's log
assert.equal(C.createOutcome(out([C.FACTORY, ["EVENT_JSON:{bad", "plain text", "EVENT_JSON:null", ev("other")]])), "unknown");
assert.equal(C.createOutcome(out([C.FACTORY, ["EVENT_JSON:" + JSON.stringify({ standard: "cleartopay", event: "contract_created" })]])), "unknown");
assert.equal(C.createOutcome(out([C.FACTORY, [ev("create_failed_refund_owed")]])), "owed");
// a failed receipt keeps its logs: its events must not count
assert.equal(C.createOutcome(out([C.FACTORY, [ev("create_failed_refunded")], { Failure: {} }])), "unknown");
assert.equal(C.createOutcome(out([C.FACTORY, [ev("contract_created")], { Failure: {} }])), "unknown");
assert.equal(C.createOutcome(out([C.FACTORY, [ev("contract_created")], { SuccessReceiptId: "x" }])), "created");
assert.equal(C.createOutcome(null), "unknown");
assert.equal(C.createOutcome({}), "unknown");

// claiming an owed refund: one call, nothing attached
assert.deepEqual(C.claimTx(), { receiverId: C.FACTORY, actions: [{ type: "FunctionCall", params: { methodName: "claim_refund", args: {}, gas: "30000000000000", deposit: "0" } }] });

// registering with USDC
assert.deepEqual(C.registerTx("acme.factory.cleartopay.testnet"), { receiverId: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af", actions: [
  { type: "FunctionCall", params: { methodName: "storage_deposit", args: { account_id: "acme.factory.cleartopay.testnet", registration_only: true }, gas: "30000000000000", deposit: "1250000000000000000000" } }] });
assert.throws(() => C.registerTx(""), /No contract/);

// read-back: our code, no keys, the buyer as owner
const good = { acct: { code_hash: C.CODE_HASH_B58 }, keys: { keys: [] }, owner: "acme.testnet", buyer: "acme.testnet" };
assert.deepEqual(C.readBack(good), { code: true, locked: true, own: true, ok: true });
assert.equal(C.readBack({ ...good, acct: { code_hash: "11111111111111111111111111111111" } }).ok, false);
assert.equal(C.readBack({ ...good, keys: { keys: [{ public_key: "ed25519:x" }] } }).locked, false);
assert.equal(C.readBack({ ...good, owner: "evil.testnet" }).own, false);
assert.equal(C.readBack({ ...good, owner: null, buyer: null }).ok, false);
assert.equal(C.readBack({ acct: null, keys: null, owner: null, buyer: "acme.testnet" }).ok, false);

console.log("create: names, factory check, the one create call, the factory's verdict, USDC registration and read-back all hold");
