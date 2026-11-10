// "Receive on another chain" in the browser (docs/console/receive-as.js), checked offline:
// the quote request is built only from what the supplier chose, the sandbox's answer must repeat
// it exactly before any money moves, the wallet is asked for exactly one transaction to the token,
// and a swap's status is read in plain words. The answers below are real ones from Tidepool
// (NEAR testnet, 2026-11-10), trimmed. node test/receive.mjs
import assert from "node:assert/strict";
const R = await import("../../../docs/console/receive-as.js");

const NOW = Date.parse("2026-11-10T19:19:00.000Z");
const ME = "payout-test.cleartopay.testnet", TO = "0x5bA9f1e397497b5f847d387EecC825d11998503c";
const base = { destId: "base-usdc", amount: "1", recipient: TO, refundTo: ME, now: NOW };

// ---- the request: only what the supplier chose, a failed swap returns to their own account
const req = R.buildQuote(base);
assert.deepEqual(req, {
  dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100,
  originAsset: "nep141:usdc.tidepool-sandbox.testnet", depositType: "ORIGIN_CHAIN",
  destinationAsset: "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet", amount: "1000000",
  recipient: TO, recipientType: "DESTINATION_CHAIN", refundTo: ME, refundType: "ORIGIN_CHAIN",
  deadline: "2026-11-10T20:19:00.000Z",
});
assert.equal(R.buildQuote({ ...base, amount: "12.5" }).amount, "12500000");
assert.equal(R.buildQuote({ ...base, destId: "arb-usdt" }).destinationAsset, "nep141:arb-0xc15cf5600225302675604310094f134e88705e62.tp-omft.testnet");
// every destination is a distinct asset on the sandbox's bridge
assert.equal(new Set(R.DESTS.map((d) => d.asset)).size, R.DESTS.length);
assert.ok(R.DESTS.every((d) => /^nep141:(base|arb|eth)-0x[0-9a-f]{40}\.tp-omft\.testnet$/.test(d.asset) && /^https:\/\//.test(d.explorer)));

// refusals, each a plain sentence
const no = (x, re) => assert.throws(() => R.buildQuote({ ...base, ...x }), re);
no({ destId: "moon" }, /Choose where/);
no({ amount: "0" }, /above zero/);
no({ amount: "-1" }, /above zero/);
no({ amount: "1.0000001" }, /above zero/);            // more than 6 decimals
no({ amount: "abc" }, /above zero/);
no({ recipient: "0x1234" }, /0x followed by 40/);
no({ recipient: "someone.testnet" }, /0x followed by 40/);
no({ recipient: "0x" + "0".repeat(40) }, /zero address/);
no({ refundTo: "" }, /nowhere to return/);
no({ minutes: 60 * 48 }, /between 5 minutes and 24 hours/); // the sandbox refuses more than 24 hours

// ---- the answer must repeat the request (a real answer, with this request's type and deadline)
const DEP = "83178a6baf82f59ab5522d1e0b1179ba82dd249f8f6a4c2347c60fd30bd58e9e";
const answer = () => ({
  correlationId: "ae77b70b-a866-4b91-903c-e6220880c997", timestamp: "2026-11-10T19:19:21.429Z",
  quoteRequest: { ...req },
  quote: { amountIn: "1000000", amountInFormatted: "1", minAmountIn: "1000000", amountOut: "997400", amountOutFormatted: "0.9974", minAmountOut: "987426", timeEstimate: 60, depositAddress: DEP, deadline: req.deadline, timeWhenInactive: req.deadline },
});
assert.deepEqual(R.checkQuote(answer(), req, NOW), { depositAddress: DEP, amountIn: "1000000", amountOut: "997400", minAmountOut: "987426", deadline: req.deadline });
// the service may write the 0x address in another letter case: same address
{ const a = answer(); a.quoteRequest.recipient = TO.toLowerCase(); assert.ok(R.checkQuote(a, req, NOW)); }

const bad = (edit, re) => { const a = answer(); edit(a); assert.throws(() => R.checkQuote(a, req, NOW), re); };
bad((a) => { a.quoteRequest.recipient = "0x000000000000000000000000000000000000dEaD"; }, /receiving address changed/); // someone else's address
bad((a) => { a.quoteRequest.destinationAsset = R.DESTS[1].asset; }, /destinationAsset changed/);
bad((a) => { a.quoteRequest.refundTo = "evil.testnet"; }, /refundTo changed/);
bad((a) => { a.quoteRequest.amount = "2000000"; }, /amount changed/);
bad((a) => { a.quoteRequest.dry = true; }, /only a preview/);
bad((a) => { delete a.quote.depositAddress; }, /not a NEAR account/);            // a preview has no address
bad((a) => { a.quote.depositAddress = "evil.testnet"; }, /not a NEAR account/);  // only a fresh implicit account
bad((a) => { a.quote.depositAddress = DEP.toUpperCase(); }, /not a NEAR account/);
bad((a) => { a.quote.amountIn = "5000000"; }, /amount to send changed/);
bad((a) => { a.quote.minAmountOut = "100"; }, /less than 90%/);                  // a ruinous price
bad((a) => { a.quote.minAmountOut = "0"; }, /makes no sense/);
bad((a) => { a.quote.minAmountOut = "999999"; }, /makes no sense/);              // "at least" above the estimate
bad((a) => { a.quote.amountOut = "1500000"; a.quote.minAmountOut = "1400000"; }, /more than you send/);
bad((a) => { a.quote.amountOut = "-1"; }, /not numbers/);
bad((a) => { a.quote.deadline = "2026-11-10T19:00:00.000Z"; }, /already expired/);
bad((a) => { a.quote.deadline = "2027-01-01T00:00:00.000Z"; }, /lives too long/);
bad((a) => { a.quote.deadline = "soon"; }, /already expired/);
for (const junk of [null, undefined, "", 7, [], {}, { quote: {} }, { quoteRequest: {} }, { message: "originAsset and destinationAsset must differ" }])
  assert.throws(() => R.checkQuote(junk, req, NOW), /does not match what you asked/);

// ---- the wallet is asked for one transaction, to the token, with exactly two calls
const tx = R.depositTx({ depositAddress: DEP, amount: "1000000" });
assert.deepEqual(tx, { receiverId: "usdc.tidepool-sandbox.testnet", actions: [
  { type: "FunctionCall", params: { methodName: "storage_deposit", args: { account_id: DEP, registration_only: true }, gas: "30000000000000", deposit: "1250000000000000000000" } },
  { type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: DEP, amount: "1000000" }, gas: "30000000000000", deposit: "1" } },
] });
assert.throws(() => R.depositTx({ depositAddress: "evil.testnet", amount: "1" }), /not a NEAR account/);
assert.throws(() => R.depositTx({ depositAddress: DEP, amount: "0" }), /above zero/);
assert.throws(() => R.depositTx({ depositAddress: DEP, amount: "1.5" }), /above zero/);

// ---- reading the status (the SUCCESS answer is the real one for the swap above)
const success = { status: "SUCCESS", swapDetails: { destinationChainTxHashes: [
  { hash: "Qfqy8cJvACLyMtf71ToeYFSq2nBR5bNatHk17xifmUT", explorerUrl: "https://testnet.nearblocks.io/txns/Qfqy8cJvACLyMtf71ToeYFSq2nBR5bNatHk17xifmUT" },
  { hash: "0x62f48f966d4e52b6ad9b956a02a143eb531dc89537c622224d52a6bbd7258a0a", explorerUrl: "https://sepolia.basescan.org/tx/0x62f48f966d4e52b6ad9b956a02a143eb531dc89537c622224d52a6bbd7258a0a" }] } };
const done = R.readStatus(success);
assert.equal(done.state, "done"); assert.equal(done.final, true);
assert.equal(done.link, "https://sepolia.basescan.org/tx/0x62f48f966d4e52b6ad9b956a02a143eb531dc89537c622224d52a6bbd7258a0a"); // the other chain, not the NEAR hop
assert.deepEqual([R.readStatus({ status: "PENDING_DEPOSIT" }).state, R.readStatus({ status: "PROCESSING" }).state, R.readStatus({ status: "KNOWN_DEPOSIT_TX" }).state], ["wait", "work", "work"]);
assert.deepEqual([R.readStatus({ status: "REFUNDED" }).state, R.readStatus({ status: "FAILED" }).state], ["back", "fail"]);
assert.ok(R.readStatus({ status: "REFUNDED" }).final && R.readStatus({ status: "FAILED" }).final && !R.readStatus({ status: "PROCESSING" }).final);
// a link that is not plain https is never shown
assert.equal(R.readStatus({ status: "SUCCESS", swapDetails: { destinationChainTxHashes: [{ explorerUrl: "javascript:alert(1)" }, { explorerUrl: "http://sepolia.basescan.org/tx/0x1" }, { explorerUrl: 'https://x.io/"><script>' }] } }).link, null);
for (const junk of [null, undefined, {}, { status: 5 }, { status: "NEW_THING" }, { status: "SUCCESS", swapDetails: { destinationChainTxHashes: "x" } }])
  assert.ok(["wait", "done"].includes(R.readStatus(junk).state));

console.log("receive-as: request, answer check, wallet transaction and status all hold");
