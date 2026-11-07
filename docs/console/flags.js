// Clear to Pay: addresses seen in a seized invoice. Every SEIZED receipt for `payee_mismatch` records
// the address the invoice asked to be paid to, which was not the supplier's registered one. This reads
// those receipts from the live and the demo contract, in the browser, and warns when an address shows
// up again. A warning, never a block: anyone can name any address in a fake invoice, so an honest
// supplier's address could be named too. A person looks at the receipt and calls the supplier.
import { CONTRACTS, view, esc, TX } from "./chain.js";

const KEY = "ctp-flags:v1";
const store = { get: () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } }, set: (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} } };
let loading = null;

/** { address: [{ contract, id, invoice, supplier }] } from every contract. Receipts never change once
 *  written, so this browser keeps what it has read and asks only for new ones. */
export function loadFlags() {
  if (loading) return loading;
  loading = (async () => {
    const memo = store.get() || { seen: {}, hits: [] };
    for (const c of Object.values(CONTRACTS)) {
      let n = 0; try { n = await view(c, "receipt_count"); } catch { continue; }
      const from = Math.max(memo.seen[c] || 0, n - 2000), ids = [];
      for (let i = from; i < n; i++) ids.push(i);
      for (let i = 0; i < ids.length; i += 8) {
        const rs = await Promise.all(ids.slice(i, i + 8).map((id) => view(c, "get_receipt", { receipt_id: id }).catch(() => null)));
        for (const r of rs) {
          if (r && r.verdict === "Seized" && (r.reasons || []).includes("payee_mismatch") && r.payee && typeof r.payee.address === "string")
            memo.hits.push({ address: r.payee.address, contract: c, id: r.id, invoice: r.invoice_number, supplier: r.supplier_id });
        }
      }
      memo.seen[c] = n;
    }
    store.set(memo);
    const by = {};
    for (const h of memo.hits) (by[h.address] ||= []).push(h);
    return by;
  })().finally(() => setTimeout(() => (loading = null), 60_000));
  return loading;
}

export async function flagsFor(address) {
  const a = String(address || "").trim(); if (!a) return [];
  try { return (await loadFlags())[a] || []; } catch { return []; }
}

const NET = { "guard.cleartopay.testnet": "live contract", "judge.cleartopay.testnet": "Judge mode" };
const ledger = (c) => new URL(`../ledger/${c === "judge.cleartopay.testnet" ? "#judge" : ""}`, import.meta.url).href;

/** The warning shown next to an address. Empty when the address was never in a seized invoice. */
export function flagHtml(address, hits) {
  if (!hits || !hits.length) return "";
  const list = hits.slice(-5).reverse().map((h) => `<li>receipt #${h.id} · ${esc(h.invoice)} · ${esc(NET[h.contract] || h.contract)} · <a href="${esc(ledger(h.contract))}" target="_blank" rel="noopener">ledger</a></li>`).join("");
  return `<div class="flag" role="alert"><b>Named in ${hits.length === 1 ? "a seized invoice" : hits.length + " seized invoices"}.</b>
    <p><code>${esc(address)}</code> was the payee on an invoice the contract seized because it was not the supplier's registered address. That is how "bank details changed" fraud looks. It can also mean someone named an honest address on purpose, so this is a warning, not a block.</p>
    <ul>${list}</ul><p><b>Before you go on:</b> call the supplier on a number you already had, and hear the address read back.</p></div>`;
}

export const FLAG_CSS = `.flag{margin-top:12px;padding:12px 14px;border-left:4px solid var(--seize,#C42B1C);background:rgba(196,43,28,.07);font:400 14px/1.5 var(--body,inherit)}
.flag b{color:var(--seize,#C42B1C)}.flag p{margin:6px 0 0}.flag ul{margin:6px 0 0;padding-left:18px;font:400 12.5px/1.6 var(--mono,monospace)}
.flag code{overflow-wrap:anywhere}`;
export function injectCss() { if (document.getElementById("flag-css")) return; const s = document.createElement("style"); s.id = "flag-css"; s.textContent = FLAG_CSS; document.head.append(s); }
