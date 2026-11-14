// Clear to Pay SDK: everything an app or agent needs to work with a Clear to Pay contract, with no dependencies.
// Runs in Node 18+ and in browsers (fetch + the bundled crypto in ./crypto.js, the same build the Console uses).
//
//   import { ClearToPay, signInvoice, signDelivery } from "./sdk/index.js";
//   const ctp = new ClearToPay({ contract: "judge.cleartopay.testnet" });
//   await ctp.isGenuine();                       // the guard's exact code and no access keys, on every server
//   await ctp.receipt(3);                        // a verdict: CLEARED, HELD or SEIZED, with its reasons
//
// What it never does: decide anything. The contract checks every signature, the order, the delivery and the payee;
// the SDK only builds, signs and reads. Sending uses the caller's own key, and refuses a key that is not fenced.
import * as C from "./crypto.js";

export const TESTNET = {
  rpcs: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
  factory: "factory.cleartopay.testnet",
  contracts: { live: "guard.cleartopay.testnet", demo: "judge.cleartopay.testnet" },
  usdc: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  relay: "https://ctp-alerts.cleartopay.workers.dev",
};
/** The guard's code as NEAR reports it (base58 of its sha-256). The Console, the ledger and the relay pin the same value. */
export const GUARD_CODE_B58 = "BUPx787xeoyTt73KmLNRfN5CQRzhfpZsgKT26HmmqWoJ";
/** The two methods an agent's key may call. NEAR enforces this on the key itself. */
export const AGENT_METHODS = ["submit_invoice", "execute_payment"];

const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const b64json = (o) => C.base64.encode(new TextEncoder().encode(JSON.stringify(o)));

async function rpcAt(url, method, params, ms = 15000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "ctp-sdk", method, params }) });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.data ? JSON.stringify(j.error.data) : j.error.message || "RPC error"); e.rpc = j.error; throw e; }
    return j.result;
  } finally { clearTimeout(t); }
}

export class ClearToPay {
  /** @param {{contract: string, rpcs?: string[], fetchTimeoutMs?: number}} o */
  constructor({ contract, rpcs = TESTNET.rpcs, fetchTimeoutMs = 15000 } = {}) {
    if (!ACCOUNT.test(contract || "")) throw new Error("contract: a NEAR account name");
    this.contract = contract; this.rpcs = rpcs; this.ms = fetchTimeoutMs;
  }
  /** One RPC call, trying each server in turn. */
  async rpc(method, params, ms = this.ms) {
    let last;
    for (const url of this.rpcs) {
      try { return await rpcAt(url, method, params, ms); } catch (e) { last = e; if (e.rpc && e.rpc.name !== "INTERNAL_ERROR") throw e; }
    }
    throw last;
  }
  /** A read-only contract call. */
  async view(method, args = {}) {
    const r = await this.rpc("query", { request_type: "call_function", finality: "final", account_id: this.contract, method_name: method, args_base64: b64json(args) });
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
  }
  /** Is this a real Clear to Pay contract? Every server must report the guard's exact code and no access keys. */
  async isGenuine() { return isClearToPay(this.contract, this.rpcs); }

  // ---- reads (each is one contract view)
  owner() { return this.view("get_owner"); }
  paused() { return this.view("is_paused"); }
  limits() { return this.view("get_limits"); }
  funds(token = TESTNET.usdc) { return this.view("get_funds", { token }); }
  supplierIds() { return this.view("get_supplier_ids"); }
  supplier(supplier_id) { return this.view("get_supplier", { supplier_id }); }
  order(order_id) { return this.view("get_order", { order_id }); }
  deliveryPolicy(order_id) { return this.view("get_delivery_policy", { order_id }); }
  deliverySigners() { return this.view("get_delivery_signers"); }
  receiptCount() { return this.view("receipt_count"); }
  receipt(receipt_id) { return this.view("get_receipt", { receipt_id }); }
  payment(receipt_id) { return this.view("get_payment", { receipt_id }); }

  /** What a key may do on NEAR: { fenced, receiver, methods, allowance }. fenced means: only this contract, only the agent's two methods, a set gas allowance. */
  async keyFence(account_id, public_key) {
    const k = await this.rpc("query", { request_type: "view_access_key", finality: "final", account_id, public_key });
    const fc = k.permission && k.permission.FunctionCall;
    if (!fc) return { fenced: false, reason: "full-access key" };
    const methods = fc.method_names || [];
    const fenced = fc.receiver_id === this.contract && methods.length > 0 && methods.every((m) => AGENT_METHODS.includes(m)) && fc.allowance != null;
    return { fenced, receiver: fc.receiver_id, methods, allowance: fc.allowance, reason: fenced ? null : "not limited to this contract's agent methods with a gas allowance" };
  }

  /** Submit an invoice with the agent's fenced key. The contract decides: the result is the receipt's verdict.
   *  args: the five signed objects, as from submitArgs(). Refuses to send with a key that is not fenced. */
  async submitInvoice({ account, secretKey, args, gas = 300_000_000_000_000n }) {
    return this.#call({ account, secretKey, method: "submit_invoice", args, gas });
  }
  /** Retry a CLEARED payment that did not settle (the agent's other method). */
  async executePayment({ account, secretKey, receiptId, gas = 100_000_000_000_000n }) {
    return this.#call({ account, secretKey, method: "execute_payment", args: { receipt_id: receiptId }, gas });
  }
  async #call({ account, secretKey, method, args, gas }) {
    const pub = C.keyFromSecret(secretKey).publicKey;
    const fence = await this.keyFence(account, pub);
    if (!fence.fenced) throw new Error("refused: this key is not fenced to the contract (" + fence.reason + "). Use a function-call key limited to submit_invoice and execute_payment.");
    for (let attempt = 0; attempt < 2; attempt++) {
      const ak = await this.rpc("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: pub });
      const s = C.signFunctionCall({ secret: secretKey, signerId: account, receiverId: this.contract, nonce: BigInt(ak.nonce) + 1n, blockHash: ak.block_hash, methodName: method, args, gas: BigInt(gas) });
      try {
        let res;
        try { res = await this.rpc("send_tx", { signed_tx_base64: s.signedB64, wait_until: "EXECUTED_OPTIMISTIC" }, 60000); }
        catch (e) { if (e.rpc?.name === "HANDLER_ERROR" || e.name === "AbortError") res = await this.rpc("tx", { tx_hash: s.hash, sender_account_id: account, wait_until: "EXECUTED_OPTIMISTIC" }, 60000); else throw e; }
        return { hash: s.hash, value: returnValue(res), outcome: res };
      } catch (e) { if (attempt === 0 && /InvalidNonce/.test(e.message)) continue; throw e; }
    }
  }
}

/** The contract's return value from a transaction outcome (e.g. submit_invoice's verdict), or null. */
export function returnValue(res) {
  const v = res && res.status && res.status.SuccessValue;
  if (!v) return null;
  try { return JSON.parse(new TextDecoder().decode(C.base64.decode(v))); } catch { return null; }
}

/** Is `account` a real Clear to Pay contract? Every server must report the guard's exact code and no access keys. */
export async function isClearToPay(account, rpcs = TESTNET.rpcs) {
  if (!ACCOUNT.test(account || "")) return false;
  const at = async (url) => {
    try {
      const q = (request_type) => rpcAt(url, "query", { request_type, finality: "final", account_id: account }, 12000);
      const [acct, keys] = await Promise.all([q("view_account"), q("view_access_key_list")]);
      return !!acct && acct.code_hash === GUARD_CODE_B58 && !!keys && Array.isArray(keys.keys) && keys.keys.length === 0;
    } catch { return false; }
  };
  return (await Promise.all(rpcs.map(at))).every(Boolean);
}

// ---- signing: the exact messages the contract checks (borsh, domain-separated, bound to one contract)

/** sha-256 of the invoice file's bytes, as the contract stores it (base64). */
export const documentHash = (bytes) => C.base64.encode(C.unhex(C.sha256Hex(bytes)));

/** The supplier signs an invoice for one contract and one exact document. Returns supplier_signature (base64). */
export function signInvoice({ secretKey, contract, invoice, document, documentHashB64 }) {
  const dh = documentHashB64 ? C.base64.decode(documentHashB64) : C.unhex(C.sha256Hex(document));
  return C.signDigest(secretKey, C.invoiceDigest(contract, invoice, dh));
}
/** Does the supplier's key sign this invoice and document for this contract? */
export function verifyInvoice({ publicKey, contract, invoice, documentHashB64, signature }) {
  try { return C.verifyDigest(publicKey, C.invoiceDigest(contract, invoice, C.base64.decode(documentHashB64)), signature); } catch { return false; }
}
/** A delivery signer confirms a note in one role, under the order's current policy version. Returns { key, signature }. */
export function signDelivery({ secretKey, contract, note, role, policyVersion }) {
  return { key: C.keyFromSecret(secretKey).publicKey, signature: C.signDigest(secretKey, C.deliveryDigest(contract, note, role, policyVersion)) };
}
/** Does this delivery signature hold for the note, role and policy version? */
export function verifyDelivery({ contract, note, role, policyVersion, key, signature }) {
  try { return C.verifyDigest(key, C.deliveryDigest(contract, note, role, policyVersion), signature); } catch { return false; }
}
/** The five objects submit_invoice takes, checked for shape. */
export function submitArgs({ invoice, supplierSignature, delivery, deliverySignatures, documentHashB64 }) {
  if (!invoice || !delivery || !supplierSignature || !Array.isArray(deliverySignatures) || !documentHashB64) throw new Error("submitArgs: invoice, supplierSignature, delivery, deliverySignatures and documentHashB64 are all needed");
  if (C.base64.decode(documentHashB64).length !== 32) throw new Error("document hash must be 32 bytes");
  return { invoice, supplier_signature: supplierSignature, delivery, delivery_signatures: deliverySignatures, document_hash: documentHashB64 };
}
/** A new ed25519 key pair (ctp-sign's key-file shape). Keep secret_key out of logs and repositories. */
export const newKey = () => C.newKeyFile();
export const publicKeyOf = (secretKey) => C.keyFromSecret(secretKey).publicKey;
