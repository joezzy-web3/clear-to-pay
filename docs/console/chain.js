// Clear to Pay Console: shared helpers for the static pages (no server, no keys).
export const CONTRACTS = { live: "guard.cleartopay.testnet", demo: "judge.cleartopay.testnet" };
export const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
export const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
export const TX = (h) => "https://testnet.nearblocks.io/txns/" + encodeURIComponent(h);
export const SITE = "https://clear-to-pay.vercel.app/console/";

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const short = (s, n = 8) => (s && s.length > 2 * n + 1 ? s.slice(0, n) + "…" + s.slice(-n) : s || "");

// ---- shape checks: the same rules the contract applies (src/lib.rs, src/inspection.rs)
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

/** "7.80" (USDC) → "7800000" (6 decimals), exactly, without floats. Null if not a plain amount. */
export function toUnits(text, decimals = 6) {
  const m = /^\s*(\d{1,24})(?:\.(\d+))?\s*$/.exec(String(text));
  if (!m || (m[2] && m[2].length > decimals)) return null;
  return (BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] || "").padEnd(decimals, "0") || "0")).toString();
}
export function fromUnits(units, decimals = 6) {
  const v = BigInt(units || 0), d = 10n ** BigInt(decimals), f = (v % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (v / d).toString() + "." + (f.length < 2 ? f.padEnd(2, "0") : f);
}

// ---- base64url JSON for links
export const encodeLink = (o) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function decodeLink(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))));
}

// ---- NEAR RPC, with a fallback server
let rpcIndex = 0;
export async function rpc(method, params, ms = 15000) {
  let last;
  for (let n = 0; n < RPCS.length; n++) {
    const k = (rpcIndex + n) % RPCS.length, ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(RPCS[k], { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "ctp", method, params }) });
      const j = await r.json(); clearTimeout(t);
      if (j.error) { const e = new Error(j.error.data ? JSON.stringify(j.error.data) : j.error.message || "RPC error"); e.rpc = j.error; throw e; }
      rpcIndex = k; return j.result;
    } catch (e) { clearTimeout(t); last = e; if (e.rpc && e.rpc.name !== "INTERNAL_ERROR") throw e; }
  }
  throw last;
}
const b64json = (o) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))));
export async function view(contract, method, args = {}, finality = "final") {
  const r = await rpc("query", { request_type: "call_function", finality, account_id: contract, method_name: method, args_base64: b64json(args) });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
}

/** The phone menu (same behaviour as every other page). */
export function initMenu() {
  const b = $("burger"), d = $("drawer"), s = $("scrim");
  if (!b || !d) return;
  const set = (open) => {
    document.body.classList.toggle("menu-open", open);
    b.setAttribute("aria-expanded", String(open)); d.setAttribute("aria-hidden", String(!open)); d.inert = !open;
    if (open) d.querySelector("a,button").focus(); else b.focus({ preventScroll: true });
  };
  d.inert = true;
  b.addEventListener("click", () => set(true));
  s.addEventListener("click", () => set(false));
  $("drawer-x").addEventListener("click", () => set(false));
  d.querySelectorAll("nav a").forEach((a) => a.addEventListener("click", () => set(false)));
  addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("menu-open")) set(false); });
  addEventListener("resize", () => { if (innerWidth > 900 && document.body.classList.contains("menu-open")) set(false); });
}

export async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select(); try { document.execCommand("copy"); } catch {} t.remove();
  }
  if (btn) { const o = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = o), 1400); }
}

// ---- Telegram alerts (workers/alerts): one tap on Start subscribes that person
export const BOT = "CleartoPayAlertsBOT";
export const netOf = (contract) => Object.entries(CONTRACTS).find(([, c]) => c === contract)?.[0] || null;
const b64u = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** role: "buyer" | "signers" | { supplier: id } */
export function alertLink(contract, role) {
  const net = netOf(contract); if (!net) return null;
  const p = role === "buyer" ? `${net}_b` : role === "signers" ? `${net}_g` : `${net}_s_${b64u(role.supplier)}`;
  return `https://t.me/${BOT}?start=${p}`;
}

/** Meteor's wallet-selector module (in wallet.js) only takes near-api-js action objects and converts
 *  them itself; every other wallet takes { type, params }. Give Meteor what it expects. */
export function walletFix(w) {
  if (!w || w.id !== "meteor-wallet") return w;
  const naj = (a) => {
    const p = a.params || {};
    if (a.type === "FunctionCall") return { functionCall: { methodName: p.methodName, args: new TextEncoder().encode(JSON.stringify(p.args)), gas: BigInt(p.gas), deposit: BigInt(p.deposit) } };
    if (a.type === "Transfer") return { transfer: { deposit: BigInt(p.deposit) } };
    if (a.type === "DeleteKey") return { deleteKey: { publicKey: { toString: () => p.publicKey } } };
    return a;
  };
  return new Proxy(w, { get(t, k) {
    if (k === "signAndSendTransaction") return (x) => t.signAndSendTransaction({ ...x, actions: x.actions.map(naj) });
    if (k === "signAndSendTransactions") return (x) => t.signAndSendTransactions({ ...x, transactions: x.transactions.map((tx) => ({ ...tx, actions: tx.actions.map(naj) })) });
    const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
  } });
}

/** The signature relay (workers/alerts, route /relay): signed send-back links travel from phones to the
 *  buyer's Inbox without anyone carrying them. Public data only; the Inbox verifies every item on chain. */
export const RELAY = "https://ctp-alerts.cleartopay.workers.dev"; // your alerts worker, e.g. https://ctp-alerts.<you>.workers.dev (until set, signatures travel by link only)
export const relayNet = (contract) => Object.entries(CONTRACTS).find(([, c]) => c === contract)?.[0] || null;
export async function relaySend(contract, hash) {
  const net = relayNet(contract); if (!RELAY.startsWith("https://") || !net) return false;
  try { const r = await fetch(`${RELAY}/relay?net=${net}`, { method: "POST", body: hash }); return r.ok; } catch { return false; }
}
export async function relayIds(net) {
  if (!RELAY.startsWith("https://")) return [];
  const r = await fetch(`${RELAY}/relay?net=${net}`, { cache: "no-store" }); return r.ok ? (await r.json()).ids || [] : [];
}
export async function relayGet(net, id) {
  const r = await fetch(`${RELAY}/relay?net=${net}&id=${id}`, { cache: "no-store" }); return r.ok ? r.text() : null;
}
