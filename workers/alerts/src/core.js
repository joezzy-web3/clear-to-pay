// Clear to Pay alerts: what changed on the contract, and who must hear it.
// A port of reader/ctp_reader/alerts.py (snapshot + changes) with one addition: every alert
// names its audience ("buyer", "supplier:<id>", "signers"), so the buyer and each supplier
// get their own messages. Read-only: public contract views, no keys.

export const LEDGER = "https://clear-to-pay.vercel.app/ledger/";
const FINAL = new Set(["Settled", "Cancelled"]);
const H72 = 72n * 3600n * 1_000_000_000n;
export const MAX_NEW_RECEIPTS = 10; // per tick; the rest are picked up next minute

export const BUYER_ACTIONS = {
  delivery_signatures_missing: "The delivery note has not been confirmed by every role the order requires. Ask the missing signer to check the goods and sign the note; then resubmit.",
  invalid_delivery_signature: "A delivery signature does not verify. Ask the signers to sign the note again with their registered keys.",
  delivery_signer_role_not_allowed: "A signer's role is not allowed for this order. Get the note signed by the roles the order requires.",
  duplicate_delivery_signer: "The same signer signed twice. A second, different role must sign.",
  duplicate_delivery_role: "Two signers share one role. A signer in a different role must sign.",
  unknown_storekeeper: "A delivery signer is not registered. Use a registered signer, or register this one first.",
  over_invoice_limit: "The invoice is above the per-invoice limit. Approve a higher limit deliberately, or pay it outside the agent.",
  over_period_limit: "The supplier's limit for this period is used up. Wait for the next period, or raise the limit deliberately.",
  limits_not_set: "No spending limits are set, so nothing can clear. Set limits first.",
  payee_not_yet_payable: "The supplier's address is still in its 72-hour wait. Resubmit after the time shown on the ledger.",
  unknown_supplier: "This supplier is not registered. Register it (its address then waits 72 hours) before paying.",
  arithmetic_overflow: "The numbers are impossibly large. Treat the document as suspect.",
};
export const SEIZED_NEXT = (n) => `Do not reply to the message this invoice came with, and do not use any contact details in it. Contact the supplier by a phone number or address already on file and ask whether they sent invoice ${n}. Nothing was paid, and this document can never be paid.`;

export function usdc(units) {
  const v = BigInt(units || 0), whole = v / 1_000_000n, frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return whole.toString() + "." + (frac.length <= 2 ? frac.padEnd(2, "0") : frac);
}
export function when(ns) {
  const d = new Date(Number(BigInt(ns) / 1_000_000n));
  const f = (tz) => d.toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${f("UTC")} UTC (${d.toLocaleTimeString("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hour12: false })} Lagos)`;
}
const A = (level, text, to) => ({ level, text, to });

/** What the contract says now. Receipts already seen are not fetched again. */
export async function snapshot(view, token, known = null) {
  known = known || {};
  let listed = [];
  try { listed = (await view("get_supplier_ids", {})) || []; } catch {}
  const receipts = { ...(known.receipts || {}) };
  const count = Number(await view("receipt_count", {}));
  const start = Object.keys(receipts).length;
  for (let i = start; i < Math.min(count, start + MAX_NEW_RECEIPTS); i++) {
    const r = await view("get_receipt", { receipt_id: i });
    if (r) receipts[String(i)] = { verdict: r.verdict, reasons: r.reasons, invoice_number: r.invoice_number, supplier_id: r.supplier_id, amount: r.amount, order_id: r.order_id };
  }
  const payments = { ...(known.payments || {}) };
  for (const [i, r] of Object.entries(receipts)) {
    if (r.verdict === "Cleared" && !FINAL.has(payments[i]?.status)) {
      const p = await view("get_payment", { receipt_id: Number(i) });
      if (p) payments[i] = { status: p.status, amount: p.amount, attempt: p.attempt, to: p.recipient?.address };
    }
  }
  const suppliers = {};
  for (const s of listed) {
    const v = await view("get_supplier", { supplier_id: s });
    if (v) suppliers[s] = { route: v.route_on_file.address, payable_from: String(v.route_payable_from), nonce: String(v.last_nonce ?? "0"),
      pending: v.pending ? { route: v.pending.route.address, proposed_at: String(v.pending.proposed_at), approved: !!v.pending.approved } : null };
  }
  const signers = {};
  for (const s of (await view("get_delivery_signers", {})) || []) signers[s.key] = s.role;
  const f = (await view("get_funds", { token })) || {};
  return { receipts, payments, suppliers, signers, funds: { available: String(f.available ?? "0"), reserved: String(f.reserved ?? "0") } };
}

/** One alert per change, alarms first, each with its audience. */
export function changes(old, now) {
  const out = [];
  const both = (s) => ["buyer", "supplier:" + s];
  for (const [s, cur] of Object.entries(now.suppliers)) {
    const before = old.suppliers?.[s] || {};
    const p = cur.pending, q = before.pending || null;
    const pNew = p && (!q || q.route !== p.route || q.proposed_at !== p.proposed_at);
    if (Object.keys(before).length && Number(cur.nonce) > Number(before.nonce || 0) + (pNew ? 1 : 0))
      out.push(A("ALARM", `Payout address activity for ${s} between checks: the signed-change counter went from ${before.nonce} to ${cur.nonce}. Check the ledger and the supplier's address now.`, both(s)));
    if (!Object.keys(before).length && old.suppliers && !(s in old.suppliers))
      out.push(A("ALARM", `New supplier registered: ${s}, payout address ${cur.route}. Not expected? It cannot be paid for 72 hours; tell the buyer now.`, both(s)));
    if (pNew) {
      const eta = BigInt(p.proposed_at) + H72;
      out.push(A("ALARM", `Payout address change PROPOSED for ${s}: ${before.route || cur.route} -> ${p.route}. Earliest it could be paid: ${when(eta)}, and only if the buyer approves. Did not ask for this? Supplier: call the buyer now. Buyer: do not approve; cancel it (cancel_payout_change).`, both(s)));
    } else if (p && q && p.approved && !q.approved) {
      out.push(A("ALARM", `Payout address change APPROVED for ${s}: -> ${p.route}. It takes effect ${when(BigInt(p.proposed_at) + H72)}. Not expected? The buyer can still cancel it until then.`, both(s)));
    } else if (q && !p) {
      out.push(A("INFO", cur.route === q.route ? `Payout address for ${s} is now ${cur.route} (the approved change took effect).` : `Payout address change for ${s} to ${q.route} was cancelled. Address stays ${cur.route}.`, both(s)));
    } else if (Object.keys(before).length && before.route !== cur.route && !q) {
      out.push(A("ALARM", `Payout address for ${s} changed: ${before.route} -> ${cur.route}.`, both(s)));
    }
  }
  for (const [k, role] of Object.entries(now.signers))
    if (!(k in (old.signers || {}))) out.push(A("ALARM", `Delivery signer ADDED: role ${role}, key ${k.slice(0, 20)}... Not expected? Remove it before any invoice is submitted.`, ["buyer", "signers"]));
  for (const [k, role] of Object.entries(old.signers || {}))
    if (!(k in now.signers)) out.push(A("INFO", `Delivery signer removed: role ${role}, key ${k.slice(0, 20)}...`, ["buyer", "signers"]));
  for (const [i, r] of Object.entries(now.receipts)) {
    if (i in (old.receipts || {})) continue;
    const amt = `${usdc(r.amount)} USDC`, reasons = (r.reasons || []).join(", "), to = both(r.supplier_id);
    if (r.verdict === "Seized") out.push(A("ALARM", `SEIZED invoice ${r.invoice_number} from ${r.supplier_id} (${amt}): ${reasons}. ${SEIZED_NEXT(r.invoice_number)} ${LEDGER}`, to));
    else if (r.verdict === "Held") {
      const steps = (r.reasons || []).filter((x) => BUYER_ACTIONS[x]).map((x) => BUYER_ACTIONS[x]);
      const fix = (r.reasons || []).filter((x) => !BUYER_ACTIONS[x]);
      out.push(A("INFO", `HELD invoice ${r.invoice_number} from ${r.supplier_id} (${amt}): ${reasons}.${steps.length ? " " + steps.join(" ") : ""}${fix.length ? ` Supplier to correct: ${fix.join(", ")}.` : ""} ${LEDGER}`, to));
    } else out.push(A("INFO", `CLEARED invoice ${r.invoice_number} from ${r.supplier_id} (${amt}). ${LEDGER}`, to));
  }
  for (const [i, p] of Object.entries(now.payments)) {
    const before = old.payments?.[i] || {};
    if (before.status === p.status && before.attempt === p.attempt) continue;
    const r = now.receipts[i] || {}, inv = r.invoice_number || `receipt ${i}`, amt = `${usdc(p.amount)} USDC`, to = both(r.supplier_id || "?");
    if (p.status === "Settled") out.push(A("INFO", `PAID: ${amt} for ${inv} reached ${p.to}.`, to));
    else if (p.status === "Failed" || p.status === "Expired") out.push(A("ALARM", `Payment ${p.status.toUpperCase()} for ${inv} (${amt}); the money is back in the pool. The buyer can reauthorise it once, to the current registered address.`, to));
    else if (p.status === "Submitted") out.push(A("INFO", `Payment sent for ${inv}: ${amt} to ${p.to}.`, to));
  }
  const a0 = BigInt(old.funds?.available ?? now.funds.available), a1 = BigInt(now.funds.available);
  const r0 = BigInt(old.funds?.reserved ?? now.funds.reserved), r1 = BigInt(now.funds.reserved);
  const paidOut = Object.entries(now.payments).filter(([i, p]) => p.status === "Settled" && old.payments?.[i]?.status !== "Settled").reduce((t, [, p]) => t + BigInt(p.amount), 0n);
  if (a1 + r1 > a0 + r0) out.push(A("INFO", `Deposit: pool +${usdc(a1 + r1 - a0 - r0)} USDC, now ${usdc(a1)} available.`, ["buyer"]));
  else if (a0 + r0 - (a1 + r1) > paidOut) out.push(A("ALARM", `Pool down ${usdc(a0 + r0 - (a1 + r1) - paidOut)} USDC not explained by a payment (a withdrawal by the owner?). Now ${usdc(a1)} available.`, ["buyer"]));
  return out.sort((x, y) => (x.level !== "ALARM") - (y.level !== "ALARM"));
}

export const format = (a, contract) => `${a.level === "ALARM" ? "ALERT" : "Clear to Pay"} | ${contract}\n${a.text}`;

// ---- subscriptions: /start payloads from the Console's "Get alerts" buttons
// <net>_b (buyer) · <net>_g (delivery signers) · <net>_s_<base64url(supplier id)>
export const b64u = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
export function parseStart(payload, nets) {
  const m = /^([a-z]{2,8})_(b|g|s_([A-Za-z0-9_-]{1,60}))$/.exec(payload || "");
  if (!m || !nets[m[1]]) return null;
  if (m[2] === "b") return { net: m[1], role: "buyer" };
  if (m[2] === "g") return { net: m[1], role: "signers" };
  let id; try { id = unb64u(m[3]); } catch { return null; }
  if (!/^[a-z0-9._-]{1,64}$/.test(id)) return null;
  return { net: m[1], role: "supplier:" + id };
}
/** Which chats get an alert: every subscriber whose roles meet the alert's audience. */
export function recipients(alert, subs) {
  return Object.entries(subs).filter(([, s]) => s.roles.some((r) => alert.to.includes(r))).map(([chat]) => chat);
}
