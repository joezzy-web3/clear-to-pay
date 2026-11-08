// Clear to Pay: the invoice from the supplier's phone to the contract, as pure functions
// (no page, no network). The Sign page builds the invoice with them; the Inbox pairs it with a
// delivery note, compares the AI's reading with what the supplier signed, and builds the one
// submit_invoice call. Tested offline in tools/console-crypto/test/flow.mjs.
import { toUnits, fromUnits, isRef, isU64 } from "./chain.js";

/** The invoice a supplier signs, built only from the order on chain and the address on file.
 *  qtys: { sku: "10", ... } (whole units, as on the order). Nothing typed can change the payee or a price. */
export function buildInvoice({ supplier_id, invoice_number, order_id, order, qtys, route }) {
  if (!order || order.supplier_id !== supplier_id) throw new Error("this order is not for your company");
  if (!isRef(invoice_number)) throw new Error("the invoice number: letters, digits and . _ / - only, up to 64");
  if (!route || !route.address) throw new Error("your company has no payout address on file");
  const lines = [];
  order.lines.forEach((l, i) => {
    const q = String(qtys[l.sku] ?? "").trim();
    if (q === "" || q === "0") return;
    if (!/^\d+$/.test(q) || !isU64(q)) throw new Error(`quantity for ${l.sku}: a whole number, please`);
    const left = BigInt(l.qty) - BigInt(order.invoiced?.[i] ?? 0);
    if (BigInt(q) > left) throw new Error(`${l.sku}: only ${left} left to invoice on this order`);
    lines.push({ sku: l.sku, qty: q, unit_price: String(l.unit_price) });
  });
  if (!lines.length) throw new Error("put a quantity on at least one line");
  const total = lines.reduce((a, l) => a + BigInt(l.qty) * BigInt(l.unit_price), 0n).toString();
  return { supplier_id, invoice_number, order_id, token: order.token, lines, total,
    payee: { chain: route.chain, token: route.token, address: route.address } };
}

/** Does what the AI read match what the supplier signed? Each field is its own check.
 *  The AI never decides: a mismatch is a reason for a person to look, not a verdict. */
export function compareReading(e, inv) {
  const out = [], add = (ok, label, detail) => out.push({ ok: !!ok, label, detail });
  if (!e) { add(false, "The AI produced no reading", "nothing to compare"); return out; }
  const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  add(same(e.supplier_id, inv.supplier_id), "Supplier", `AI read ${e.supplier_id || "nothing"} · signed ${inv.supplier_id}`);
  add(same(e.invoice_number, inv.invoice_number), "Invoice number", `AI read ${e.invoice_number || "nothing"} · signed ${inv.invoice_number}`);
  add(same(e.order_id, inv.order_id), "Order", `AI read ${e.order_id || "nothing"} · signed ${inv.order_id}`);
  const amt = (v) => { try { return toUnits(String(v ?? "").replace(/,/g, "")); } catch { return null; } };
  const qty = (v) => String(v ?? "").replace(/,/g, "").trim().replace(/\.0+$/, "");
  const t = amt(e.total);
  add(t !== null && t === String(inv.total), "Total", `AI read ${e.total ?? "nothing"} · signed ${fromUnits(inv.total)}`);
  for (const l of inv.lines) {
    const r = (e.lines || []).find((x) => same(x.sku, l.sku));
    const ok = r && qty(r.qty) === l.qty && amt(r.unit_price) === l.unit_price;
    add(ok, `Line ${l.sku}`, r ? `AI read ${r.qty} at ${r.unit_price} · signed ${l.qty} at ${fromUnits(l.unit_price)}` : "not in the AI's reading");
  }
  const extra = (e.lines || []).filter((x) => !inv.lines.some((l) => same(x.sku, l.sku)));
  if (extra.length) add(false, "Lines the supplier did not sign", extra.map((x) => x.sku).join(", "));
  return out;
}

/** Signed invoices next to READY delivery notes for the same order: what can be submitted. */
export function pairs(invoices, readyNotes) {
  return invoices.map((x) => ({ inv: x, notes: readyNotes.filter((n) => n.note.order_id === x.invoice.order_id) }));
}

/** The exact arguments of submit_invoice. With an attested reading, it rides along as `ai_reading`:
 *  the contract ignores unknown fields (it decides on the signed objects only), but the transaction keeps
 *  them on chain for good, so anyone can re-check the reading later (tools/console-crypto/recheck.mjs). */
export const READER_ID = "cleartopay-reader.testnet/reader";
export function submitArgs(inv, note, reading) {
  const args = { invoice: inv.invoice, supplier_signature: inv.signature, delivery: note.note,
    delivery_signatures: note.signatures.map((s) => ({ key: s.key, signature: s.signature })), document_hash: inv.document_hash };
  if (reading && reading.output) args.ai_reading = { reader: READER_ID, output: reading.output, attestation_url: reading.attestation_url, matched_signed_invoice: !!reading.matched };
  return args;
}
