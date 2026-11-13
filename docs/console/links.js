// Clear to Pay: shape checks and the links that carry signatures and details between phones.
// Pure functions only (no page, no network), so the Console pages and the alerts worker use the very same rules.
// The contract applies the same shape rules (src/lib.rs, src/inspection.rs); this file only spares a round trip.

export const isRef = (s) => typeof s === "string" && /^[A-Za-z0-9._\/-]{1,64}$/.test(s);
export const isSupplierId = (s) => typeof s === "string" && /^[a-z0-9._-]{1,64}$/.test(s);
export const isRole = (s) => typeof s === "string" && /^[a-z0-9-]{1,32}$/.test(s);
export const isAccount = (s) => typeof s === "string" && s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
export const isUint = (s) => typeof s === "string" && /^\d{1,39}$/.test(s);
// Exact on-chain widths (CTP7-01): a JSON string of a plain whole number (no sign, no exponent, no leading zero), in range.
const U64_MAX = (1n << 64n) - 1n, U128_MAX = (1n << 128n) - 1n;
const plain = (s) => typeof s === "string" && /^(0|[1-9]\d{0,38})$/.test(s);
export const isU64 = (s) => plain(s) && BigInt(s) <= U64_MAX;
export const isU128 = (s) => plain(s) && BigInt(s) <= U128_MAX;
export const isPubKey = (s) => typeof s === "string" && /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(s);
export const isPrintable = (s, max) => typeof s === "string" && s.length >= 1 && s.length <= max && /^[\x21-\x7e]+$/.test(s);

// ---- base64url JSON for links
export const encodeLink = (o) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function decodeLink(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))));
}

/** A send-back link (n=…&s=…&k=… for a delivery note, i=…&s=…&k=… for an invoice), checked against its signature.
 *  Returns the signed item, { bad: true } when the signature does not match, or null when it is not such a link.
 *  C is the Console's crypto module (crypto.js): the same digests the contract computes. */
export function parseBack(p, C) {
  const s = p.get("s"), k = p.get("k"); if (!s || !k || !isPubKey(k)) return null;
  try {
    if (p.get("n")) {
      const n = decodeLink(p.get("n"));
      const ok = isAccount(n.contract) && isRef(n.order_id) && isRef(n.note_id) && isRole(n.role) && Number.isInteger(n.policy_version) && Array.isArray(n.lines) && n.lines.length >= 1 && n.lines.length <= 50 && n.lines.every((l) => isRef(l.sku) && isU64(l.qty));
      if (!ok) return null;
      const note = { order_id: n.order_id, note_id: n.note_id, lines: n.lines.map((l) => ({ sku: l.sku, qty: String(l.qty) })) };
      return C.verifyDigest(k, C.deliveryDigest(n.contract, note, n.role, n.policy_version), s) ? { kind: "delivery", contract: n.contract, note, role: n.role, policy_version: n.policy_version, key: k, signature: s } : { bad: true };
    }
    if (p.get("i")) {
      const x = decodeLink(p.get("i")), v = x.invoice || {}; let doc; try { doc = C.base64.decode(x.document_hash); } catch { return null; }
      const okLines = Array.isArray(v.lines) && v.lines.length >= 1 && v.lines.length <= 50 && v.lines.every((l) => isRef(l.sku) && isU64(l.qty) && isU128(l.unit_price));
      if (!isAccount(x.contract) || !isSupplierId(v.supplier_id) || !isRef(v.invoice_number) || !isRef(v.order_id) || !isPrintable(v.token, 128) || !okLines || !isU128(v.total) || !v.payee || !isPrintable(v.payee.address, 128) || doc.length !== 32) return null;
      const invoice = { supplier_id: v.supplier_id, invoice_number: v.invoice_number, order_id: v.order_id, token: v.token, lines: v.lines.map((l) => ({ sku: l.sku, qty: String(l.qty), unit_price: String(l.unit_price) })), total: String(v.total), payee: { chain: String(v.payee.chain), token: String(v.payee.token), address: String(v.payee.address) } };
      return C.verifyDigest(k, C.invoiceDigest(x.contract, invoice, doc), s) ? { kind: "invoice", contract: x.contract, invoice, document_hash: x.document_hash, key: k, signature: s } : { bad: true };
    }
  } catch { return null; }
  return null;
}

/** A details reply (a=…): a delivery signer's or a supplier's public key and, for a supplier, the payout account it asks for.
 *  Nothing in it is signed for the chain: it is a request the buyer reviews and registers with their own wallet. */
export function parseRequest(p) {
  const a0 = p.get("a"); if (!a0 || p.get("s")) return null;
  let a; try { a = decodeLink(a0); } catch { return null; }
  if (!a || !isAccount(a.contract) || !isPubKey(a.key) || !["signer", "supplier"].includes(a.kind)) return null;
  if (a.kind === "signer") { if (a.role !== undefined && !isRole(a.role)) return null; return { kind: "request", who: "signer", contract: a.contract, key: a.key, role: a.role || null, a: a0 }; }
  if (!isSupplierId(a.supplier_id) || !isAccount(a.address)) return null;
  return { kind: "request", who: "supplier", contract: a.contract, key: a.key, supplier_id: a.supplier_id, address: a.address, proved: !!a.proof, a: a0 };
}
