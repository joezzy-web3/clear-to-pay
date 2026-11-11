// Clear to Pay: "Receive on another chain", as pure functions (no page, no network).
// After the contract has paid a supplier's registered NEAR account, the supplier may move
// that money to another chain themselves, with the wallet of that account. The buyer, the
// agent and the contract take no part: nothing here can change who the contract pays.
//
// TESTNET SANDBOX ONLY. The swap runs on Tidepool (usetidepool.tech), a community-built,
// 1Click-compatible sandbox for NEAR Intents. It swaps its own test tokens, not Circle's
// testnet USDC, and it holds the keys for everything that leaves NEAR.
// Tested offline in tools/console-crypto/test/receive.mjs.
import { toUnits, isAccount } from "./chain.js";

export const TIDEPOOL = "https://www.usetidepool.tech";
/** The only token the sandbox can swap from on NEAR: Tidepool's own test USDC (6 decimals). */
export const SWAP_TOKEN = "usdc.tidepool-sandbox.testnet";
const OMFT = ".tp-omft.testnet";
/** Where a supplier can receive. Every entry is a 6-decimal test stablecoin on an EVM testnet. */
export const DESTS = [
  { id: "base-usdc", label: "USDC on Base Sepolia", asset: "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252" + OMFT, explorer: "https://sepolia.basescan.org/address/" },
  { id: "base-usdt", label: "USDT on Base Sepolia", asset: "nep141:base-0xc15cf5600225302675604310094f134e88705e62" + OMFT, explorer: "https://sepolia.basescan.org/address/" },
  { id: "arb-usdc", label: "USDC on Arbitrum Sepolia", asset: "nep141:arb-0x38d81431b9f76d9699af7517040d5221d9dea252" + OMFT, explorer: "https://sepolia.arbiscan.io/address/" },
  { id: "arb-usdt", label: "USDT on Arbitrum Sepolia", asset: "nep141:arb-0xc15cf5600225302675604310094f134e88705e62" + OMFT, explorer: "https://sepolia.arbiscan.io/address/" },
  { id: "eth-usdc", label: "USDC on Ethereum Sepolia", asset: "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2" + OMFT, explorer: "https://sepolia.etherscan.io/address/" },
  { id: "eth-usdt", label: "USDT on Ethereum Sepolia", asset: "nep141:eth-0x650f12ba31777de8ded47287a8cc86be737646fe" + OMFT, explorer: "https://sepolia.etherscan.io/address/" },
];
export const destOf = (id) => DESTS.find((d) => d.id === id) || null;

export const isEvmAddress = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const ZERO = "0x" + "0".repeat(40);
const isUintText = (s) => typeof s === "string" && /^\d{1,39}$/.test(s);
const isImplicit = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

/** The quote request for one swap: `amount` (text, like "12.5") of test USDC from the supplier's
 *  NEAR account `refundTo`, paid out as `destId` to `recipient`. A failed swap refunds to `refundTo`.
 *  The sandbox only makes addresses that live up to 24 hours; this one lives `minutes` (default 60). */
export function buildQuote({ destId, amount, recipient, refundTo, now = Date.now(), minutes = 60 }) {
  const dest = destOf(destId);
  if (!dest) throw new Error("Choose where you want to receive.");
  const units = toUnits(amount, 6);
  if (!units || BigInt(units) === 0n) throw new Error("Type the amount as a number above zero, like 12.50 (up to 6 decimals).");
  if (!isEvmAddress(recipient)) throw new Error("Type your address on that chain: 0x followed by 40 letters and digits. Copy it from your wallet; do not type it by hand.");
  if (recipient.toLowerCase() === ZERO) throw new Error("That is the zero address: money sent there is lost. Copy your own address from your wallet.");
  if (!isAccount(refundTo)) throw new Error("Your payout account on NEAR is missing, so a failed swap would have nowhere to return to.");
  if (!(minutes >= 5 && minutes <= 24 * 60)) throw new Error("The swap address must live between 5 minutes and 24 hours.");
  return {
    dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100,
    originAsset: "nep141:" + SWAP_TOKEN, depositType: "ORIGIN_CHAIN",
    destinationAsset: dest.asset, amount: units,
    recipient, recipientType: "DESTINATION_CHAIN",
    refundTo, refundType: "ORIGIN_CHAIN",
    deadline: new Date(now + minutes * 60_000).toISOString(),
  };
}

/** Check the sandbox's answer against what was asked, before any money moves. The deposit address
 *  itself cannot be proved from here (the sandbox holds its key), so everything that can be checked
 *  is: the answer must repeat the request exactly, and the price must be sane for a stablecoin.
 *  Returns { depositAddress, amountIn, amountOut, minAmountOut, deadline }; throws a plain sentence otherwise. */
export function checkQuote(res, req, now = Date.now()) {
  const bad = (why) => new Error(`The swap service's answer does not match what you asked (${why}). Nothing was sent. Try again.`);
  const q = res && res.quoteRequest, o = res && res.quote;
  if (!q || !o || typeof q !== "object" || typeof o !== "object") throw bad("no quote in the answer");
  if (q.dry !== false) throw bad("it is only a preview");
  for (const k of ["swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "recipientType", "refundTo", "refundType", "deadline"])
    if (q[k] !== req[k]) throw bad(k + " changed");
  if (typeof q.recipient !== "string" || q.recipient.toLowerCase() !== req.recipient.toLowerCase()) throw bad("the receiving address changed");
  if (!isImplicit(o.depositAddress)) throw bad("the swap address is not a NEAR account");
  if (o.depositAddress === req.refundTo) throw bad("the swap address is your own account");
  if (![o.amountIn, o.amountOut, o.minAmountOut].every(isUintText)) throw bad("the amounts are not numbers");
  if (o.amountIn !== req.amount) throw bad("the amount to send changed");
  const out = BigInt(o.amountOut), min = BigInt(o.minAmountOut), inn = BigInt(req.amount);
  if (min > out || min === 0n) throw bad("the least you would receive makes no sense");
  // test dollars for test dollars, both with 6 decimals: refuse to lose more than a tenth, or to "gain"
  if (min * 10n < inn * 9n) throw new Error("This quote pays out less than 90% of what you send. Nothing was sent. Try again later.");
  if (out * 100n > inn * 105n) throw bad("it pays out far more than you send");
  const end = Date.parse(o.deadline);
  if (!Number.isFinite(end) || end <= now + 60_000) throw bad("the swap address has already expired");
  if (end > now + 24 * 3_600_000 + 60_000) throw bad("the swap address lives too long");
  return { depositAddress: o.depositAddress, amountIn: o.amountIn, amountOut: o.amountOut, minAmountOut: o.minAmountOut, deadline: o.deadline };
}

const TGAS_30 = "30000000000000";
/** The one transaction the supplier's wallet approves: register the swap address with the token
 *  (a fresh NEAR account cannot receive a token until it is registered; 0.00125 NEAR, and the
 *  token gives it back if the address was already registered), then send the USDC to it.
 *  Both steps are in one transaction to the token contract: both happen, or neither does. */
export function depositTx({ depositAddress, amount }) {
  if (!isImplicit(depositAddress)) throw new Error("The swap address is not a NEAR account.");
  if (!isUintText(amount) || BigInt(amount) === 0n) throw new Error("The amount is not a number above zero.");
  return {
    receiverId: SWAP_TOKEN,
    actions: [
      { type: "FunctionCall", params: { methodName: "storage_deposit", args: { account_id: depositAddress, registration_only: true }, gas: TGAS_30, deposit: "1250000000000000000000" } },
      { type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: depositAddress, amount }, gas: TGAS_30, deposit: "1" } },
    ],
  };
}

/** Only a transaction page on one of the three explorers we pay out to: anything else is never shown as "the payout". */
const EXPLORERS = ["sepolia.basescan.org", "sepolia.arbiscan.io", "sepolia.etherscan.io"];
const payoutUrl = (u) => { const m = typeof u === "string" && /^https:\/\/([a-z.]+)\/tx\/(0x[0-9a-fA-F]{64})$/.exec(u); return m && EXPLORERS.includes(m[1]) ? `https://${m[1]}/tx/${m[2]}` : null; };
/** What the sandbox says about a swap, in plain words.
 *  state: "wait" (no money seen yet) | "work" | "done" | "back" (refunded) | "fail"; `final` stops the polling.
 *  link: the payout on the destination chain's explorer, once there is one. */
export function readStatus(j) {
  const s = j && typeof j.status === "string" ? j.status : "";
  const hops = (j && j.swapDetails && Array.isArray(j.swapDetails.destinationChainTxHashes)) ? j.swapDetails.destinationChainTxHashes : [];
  const link = hops.map((h) => payoutUrl(h && h.explorerUrl)).find(Boolean) || null;
  if (s === "SUCCESS") return { state: "done", final: true, link, text: link ? "Tidepool reports it delivered. Open the payout to confirm it arrived at your address." : "Tidepool reports it delivered, but gave no payout link we recognise. Check your address on the explorer before relying on it." };
  if (s === "REFUNDED") return { state: "back", final: true, link: null, text: "Tidepool reports the swap did not go through and returned the money to your NEAR payout account. Check the balance above." };
  if (s === "FAILED") return { state: "fail", final: true, link: null, text: "Tidepool reports the swap failed and that it returns the money to your NEAR payout account. Check the balance above in a few minutes." };
  if (s === "INCOMPLETE_DEPOSIT") return { state: "work", final: false, link: null, text: "Tidepool reports less arrived than the quote asked for, and that it returns it to your NEAR payout account when the swap address expires." };
  if (s === "PROCESSING" || s === "KNOWN_DEPOSIT_TX") return { state: "work", final: false, link, text: "Your money arrived at the swap address and is being moved. This usually takes about a minute." };
  if (s === "PENDING_DEPOSIT") return { state: "wait", final: false, link: null, text: "Waiting for your money to arrive at the swap address." };
  return { state: "wait", final: false, link: null, text: "No answer from the swap service yet." };
}

/** What a wallet's answer says about the transaction: "failed" (NEAR refused it: nothing was sent),
 *  "ok" (it ran), or "unknown" (no outcome given, as some wallets do). Returns { state, hash }. */
export function walletOutcome(r) {
  const o = Array.isArray(r) ? r[r.length - 1] : r;
  const hash = o && typeof o === "object" ? (o.transaction && o.transaction.hash) || (o.transaction_outcome && o.transaction_outcome.id) || null : null;
  const st = o && typeof o === "object" ? o.status : null;
  if (st && typeof st === "object" && "Failure" in st) return { state: "failed", hash };
  if (st && typeof st === "object" && ("SuccessValue" in st || "SuccessReceiptId" in st)) return { state: "ok", hash };
  return { state: "unknown", hash };
}

const b64json = (s) => { try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))); } catch { return null; } };
/** A transaction read back from NEAR (RPC "tx"), checked against the swaps this page started.
 *  It must be signed by `me`, sent to the token, and transfer exactly one swap's amount to that swap's address.
 *  Returns { id, failed } for the swap it belongs to, or null if it belongs to none of them. */
export function matchSwapTx(t, me, swaps) {
  const tx = t && t.transaction;
  if (!tx || tx.signer_id !== me || tx.receiver_id !== SWAP_TOKEN || !Array.isArray(tx.actions)) return null;
  for (const a of tx.actions) {
    const f = a && a.FunctionCall;
    if (!f || f.method_name !== "ft_transfer") continue;
    const args = b64json(f.args);
    const s = args && swaps.find((x) => x.dep === args.receiver_id && x.amount === args.amount);
    if (s) return { id: s.id, failed: !!(t.status && typeof t.status === "object" && "Failure" in t.status) };
  }
  return null;
}
