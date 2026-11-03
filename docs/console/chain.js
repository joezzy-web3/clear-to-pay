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
export async function view(contract, method, args = {}) {
  const r = await rpc("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: b64json(args) });
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
