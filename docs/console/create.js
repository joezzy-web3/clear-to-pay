// Clear to Pay: a buyer creates its own contract from the browser, as pure functions (no page, no network).
// Wallets such as Meteor refuse to deploy code from a web page, so the deploy is done by our factory contract
// (factory/ in the repository). The buyer approves one ordinary call to it with 3.6 NEAR attached; in one
// all-or-nothing batch the factory creates `<label>.<factory>`, moves the 3.6 NEAR onto it for storage, installs the
// exact code of our Live guard and makes the caller its owner. No access key is added: the contract is locked.
// If anything fails (the name was taken meanwhile), nothing is created and the factory sends the 3.6 NEAR back, or,
// if that money is not back with it yet, records it as owed so the buyer can claim it (claimTx).
// The page never trusts the factory's word: afterwards it reads the new contract back from NEAR (code hash, no keys,
// owner). Tested offline in tools/console-crypto/test/create.mjs.
import { isAccount, USDC } from "./chain.js";
import { base58, unhex } from "./crypto.js";

/** The factory. Its own `code_hash` view must report CODE_SHA256 before the wallet opens. */
export const FACTORY = "factory.cleartopay.testnet";
/** SHA-256 of the contract code, the same as guard.cleartopay.testnet runs. */
export const CODE_SHA256 = "9b998038ac549a37c871c431e28b125437f4c7f046799d8e4e5c139dbea0a2d1";
/** NEAR shows a contract's code hash in base58; the same SHA-256. */
export const CODE_HASH_B58 = base58.encode(unhex(CODE_SHA256));
/** Attached to the call: its code costs 1 NEAR per 100 KB of storage (about 3.33 NEAR), plus room for its own records.
 *  It all stays on the new contract as storage; it is not a fee. The factory refuses less than this or more than 5. */
export const FUND_NEAR = "3.6";
export const FUND = "3600000000000000000000000";
const TGAS_30 = "30000000000000";
/** Create, install the 333 KB code, run `new`, then the factory's check: well inside 300 Tgas. Unused gas is refunded. */
export const TGAS_CREATE = "300000000000000";

/** The label before the factory's name: lowercase letters, digits, and single - or _ between them. */
export const isLabel = (s) => typeof s === "string" && s.length >= 2 && s.length <= 32 && /^[a-z0-9]+([-_][a-z0-9]+)*$/.test(s);
/** Names that would look official; the factory refuses them too. */
export const RESERVED = ["admin", "cleartopay", "clear-to-pay", "clear_to_pay", "demo", "factory", "guard", "judge", "official", "support"];

/** The new contract's account, or a plain sentence saying why not. */
export function contractName(label) {
  if (!isLabel(label)) throw new Error("Use 2 to 32 lowercase letters or digits for the name, like acme.");
  if (RESERVED.includes(label)) throw new Error("That name is reserved. Use your company's name.");
  const name = `${label}.${FACTORY}`;
  if (!isAccount(name) || name.length > 64) throw new Error("That name is too long. Choose a shorter one.");
  return name;
}

/** The factory must say it installs exactly our code (its `code_hash` view, hex). Throws before the wallet opens. */
export function checkFactory(hashHex) {
  if (hashHex !== CODE_SHA256) throw new Error("The factory does not install the expected code, so nothing was sent. Do not continue; tell us on @cleartopay.");
  return true;
}

/** The one transaction the buyer approves: a call to the factory with 3.6 NEAR attached. */
export function createTx({ buyer, label }) {
  if (!isAccount(buyer)) throw new Error("Connect a wallet first.");
  contractName(label);
  return {
    receiverId: FACTORY,
    actions: [{ type: "FunctionCall", params: { methodName: "create", args: { label }, gas: TGAS_CREATE, deposit: FUND } }],
  };
}

/** Did this receipt succeed? A failed receipt keeps its logs, so its events must not count. */
const succeeded = (st) => !!st && typeof st === "object" && ("SuccessValue" in st || "SuccessReceiptId" in st);

/** What the factory reported, from the wallet's transaction outcome: "created", "refunded", "owed" or "unknown".
 *  Only events from the factory's own receipts that succeeded count. Unknown is fine: the read-back decides. */
export function createOutcome(outcome) {
  const o = Array.isArray(outcome) ? outcome[outcome.length - 1] : outcome;
  const logs = [];
  for (const r of (o && o.receipts_outcome) || []) if (r && r.outcome && r.outcome.executor_id === FACTORY && succeeded(r.outcome.status)) logs.push(...(r.outcome.logs || []));
  let res = "unknown";
  for (const l of logs) {
    if (typeof l !== "string" || !l.startsWith("EVENT_JSON:")) continue;
    let e; try { e = JSON.parse(l.slice(11)); } catch { continue; }
    if (!e || e.standard !== "cleartopay-factory") continue;
    if (e.event === "contract_created") res = "created";
    if (e.event === "create_failed_refunded") return "refunded";
    if (e.event === "create_failed_refund_owed") return "owed";
  }
  return res;
}

/** Take a refund the factory recorded as owed (see createOutcome "owed"). Pays only the caller. */
export function claimTx() {
  return { receiverId: FACTORY, actions: [{ type: "FunctionCall", params: { methodName: "claim_refund", args: {}, gas: TGAS_30, deposit: "0" } }] };
}

/** The second approval: register the new contract with testnet USDC so it can hold the pool (0.00125 NEAR). */
export function registerTx(name) {
  if (!isAccount(name)) throw new Error("No contract name.");
  return { receiverId: USDC, actions: [{ type: "FunctionCall", params: { methodName: "storage_deposit", args: { account_id: name, registration_only: true }, gas: TGAS_30, deposit: "1250000000000000000000" } }] };
}

/** Read back from NEAR: the account must now exist, run exactly our code, have no access keys, and name the buyer
 *  as owner. `acct` is RPC view_account, `keys` is view_access_key_list, `owner` is get_owner. */
export function readBack({ acct, keys, owner, buyer }) {
  const code = !!acct && acct.code_hash === CODE_HASH_B58;
  const locked = !!keys && Array.isArray(keys.keys) && keys.keys.length === 0;
  const own = !!buyer && owner === buyer;
  return { code, locked, own, ok: code && locked && own };
}
