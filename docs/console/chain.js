// Clear to Pay Console: shared helpers for the static pages (no server, no keys).
export const CONTRACTS = { live: "guard.cleartopay.testnet", demo: "judge.cleartopay.testnet" };
export const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
export const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
export const TX = (h) => "https://testnet.nearblocks.io/txns/" + encodeURIComponent(h);
export const SITE = "https://clear-to-pay.vercel.app/console/";

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const short = (s, n = 8) => (s && s.length > 2 * n + 1 ? s.slice(0, n) + "…" + s.slice(-n) : s || "");

// ---- shape checks and links: one copy, shared with the alerts worker (links.js)
export { isRef, isSupplierId, isRole, isAccount, isUint, isU64, isU128, isPubKey, isPrintable, encodeLink, decodeLink, parseBack, parseRequest } from "./links.js";
import { isAccount } from "./links.js";

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
/** One query to one named server, no fallback: for checks that must hear the same answer from every server. */
export async function rpcAt(url, method, params, ms = 15000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "ctp", method, params }) });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.data ? JSON.stringify(j.error.data) : j.error.message || "RPC error"); e.rpc = j.error; throw e; }
    return j.result;
  } finally { clearTimeout(t); }
}
const b64json = (o) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))));
export async function view(contract, method, args = {}, finality = "final") {
  const r = await rpc("query", { request_type: "call_function", finality, account_id: contract, method_name: method, args_base64: b64json(args) });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
}

/** The phone menu (same behaviour as every other page). */
export function initMenu() {
  inboxBadge();
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
    if (a.type === "CreateAccount") return { createAccount: {} };
    if (a.type === "DeployContract") return { deployContract: { code: p.code } };
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
// Our two contracts have short names on the relay; a company's own contract goes by its account, and the relay
// accepts it only after NEAR confirms it runs the pinned guard code with no access keys (workers/alerts/src/relay.js).
export const relayNet = (contract) => (contract === CONTRACTS.live ? "live" : contract === CONTRACTS.demo ? "demo" : contract && contract === CONTRACTS.own ? contract : null);
export async function relaySend(contract, hash) {
  const net = relayNet(contract); if (!RELAY.startsWith("https://") || !net) return false;
  try { const r = await fetch(`${RELAY}/relay?net=${encodeURIComponent(net)}`, { method: "POST", body: hash }); return r.ok; } catch { return false; }
}
export async function relayIds(net) {
  if (!RELAY.startsWith("https://")) return [];
  const r = await fetch(`${RELAY}/relay?net=${encodeURIComponent(net)}`, { cache: "no-store" }); return r.ok ? (await r.json()).ids || [] : [];
}
export async function relayGet(net, id) {
  const r = await fetch(`${RELAY}/relay?net=${encodeURIComponent(net)}&id=${encodeURIComponent(id)}`, { cache: "no-store" }); return r.ok ? r.text() : null;
}

// ---------------------------------------------------------------- a company's own Clear to Pay contract (made on the New contract page)
// Kept in this browser, or opened once with ?contract=acme.factory.cleartopay.testnet; the New contract page sets it too. It joins CONTRACTS as "own", so every page
// (Buyer setup, Inbox, Sign, ledger) works with it exactly as with ours. Only a real Clear to Pay contract is accepted: both NEAR servers must
// report our guard's exact code and no access keys (so nobody can ever swap that code). A link to anything else is never saved or used.
const OWN = "ctp-own-contract";
/** The guard's code as NEAR reports it: base58 of CODE_SHA256 in create.js (test/create.mjs checks the two match). */
export const GUARD_CODE_B58 = "BUPx787xeoyTt73KmLNRfN5CQRzhfpZsgKT26HmmqWoJ";
/** Is `name` a real Clear to Pay contract? Both servers must say: our guard's exact code, and no access keys. */
export async function isClearToPay(name) {
  if (!isAccount(name)) return false;
  // A slow phone connection must not make a real contract look fake: each server gets 12 s, and one more try if the
  // connection dropped quickly. A clear answer (other code, a key) is final at once. The page waits for this, so it is capped.
  const at = async (url) => {
    const q = (request_type) => rpcAt(url, "query", { request_type, finality: "final", account_id: name }, 12000);
    for (let n = 0; ; n++) {
      const t0 = Date.now();
      try {
        const [acct, keys] = await Promise.all([q("view_account"), q("view_access_key_list")]);
        return !!acct && acct.code_hash === GUARD_CODE_B58 && !!keys && Array.isArray(keys.keys) && keys.keys.length === 0;
      } catch (e) { if (e.rpc || n >= 1 || Date.now() - t0 > 5000) return false; }
    }
  };
  return (await Promise.all(RPCS.map(at))).every(Boolean);
}
/** An address offered by a link or kept in this browser but not (yet) confirmed as a Clear to Pay contract. */
export let ownRefused = null;
export async function ownContract() {
  let q = null, kept = null;
  try { q = new URLSearchParams(location.search).get("contract"); } catch {}
  try { kept = localStorage.getItem(OWN); } catch {}
  if (["guard.cleartopay.testnet", "judge.cleartopay.testnet"].includes(q)) q = null;
  const v = isAccount(q) ? q : isAccount(kept) ? kept : null;
  if (!v) return null;
  if (!(await isClearToPay(v))) { ownRefused = v; return null; }
  if (v !== kept) try { localStorage.setItem(OWN, v); } catch {}
  return v;
}
{ const o = await ownContract(); if (o) CONTRACTS.own = o; }
/** Adds a "Your own contract" button (data key "own") to a page's contract switch, before the page wires its
 *  buttons. Until a real Clear to Pay contract is set, clicking it opens a small form instead of switching;
 *  once set, it switches like Demo and Live. Hold Alt (or click it again while on it) to change the address.
 *  `words` changes the form's label and note for people who use a buyer's contract but do not own one. */
export function ownSwitch(group, makeButton, words = {}) {
  const b = makeButton(CONTRACTS.own);
  group.appendChild(b);
  const form = document.createElement("div");
  form.className = "ownform"; form.hidden = true;
  const label = words.label || "Your contract's address", note = words.note || 'No contract yet? <a href="' + new URL("create/", SITE).pathname + '">Create one</a> in two wallet approvals, no developer. The address stays in this browser.';
  form.innerHTML = `<label>${label}<input placeholder="yourcompany.factory.cleartopay.testnet" autocomplete="off" spellcheck="false" autocapitalize="none" autocorrect="off"></label><button type="button">Use it</button><button type="button" class="x">Cancel</button><small>${note}</small><p class="err" hidden></p>`;
  group.insertAdjacentElement("afterend", form);
  const [inp] = form.getElementsByTagName("input"), [use, cancel] = form.getElementsByTagName("button"), err = form.querySelector(".err");
  if (CONTRACTS.own || ownRefused) inp.value = CONTRACTS.own || ownRefused;
  const refusedNote = () => { if (ownRefused && !CONTRACTS.own && inp.value.trim() === ownRefused) { err.hidden = false; err.textContent = `${ownRefused} was not confirmed as a Clear to Pay contract (our exact code and no access keys, on two NEAR servers), so it is not used. Check the address, or try again if NEAR was slow.`; } };
  // A saved address can be changed (this form) or forgotten in this browser. Forgetting touches nothing on NEAR.
  const hint = document.createElement("p");
  hint.className = "ownhint"; hint.hidden = !CONTRACTS.own;
  hint.innerHTML = `<button type="button" class="link">${words.hint || "Change or forget your own contract"}</button>`;
  form.insertAdjacentElement("beforebegin", hint);
  const forget = document.createElement("button");
  forget.type = "button"; forget.className = "x"; forget.textContent = "Forget it in this browser"; forget.hidden = !CONTRACTS.own;
  form.insertBefore(forget, form.querySelector("small"));
  forget.onclick = () => {
    try {
      const v = localStorage.getItem(OWN); localStorage.removeItem(OWN);
      for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith("ctp-created:") && localStorage.getItem(k) === v) localStorage.removeItem(k); }
    } catch {}
    location.href = location.pathname; // back to this page with Demo selected; the contract itself is untouched
  };
  // While the form is open the button shows as chosen; Cancel, Esc or another choice puts things back.
  let was = null, card = null;
  // The page's contract card must not keep showing the previous contract while the address is being typed.
  const CARD = ["f-c", "f-owner", "f-pool", "f-todo"];
  const blankCard = () => {
    if (card) return; card = {};
    for (const id of CARD) { const el = document.getElementById(id); if (!el) continue; card[id] = [el.textContent, el.className]; el.textContent = id === "f-c" ? "type your address, then Use it" : "–"; el.className = ""; }
  };
  const restoreCard = () => { if (!card) return; for (const id in card) { const el = document.getElementById(id); if (el) [el.textContent, el.className] = card[id]; } card = null; };
  const open = () => {
    if (!was) { was = [...group.querySelectorAll('button[aria-pressed="true"]')].filter((x) => x !== b); was.forEach((x) => x.setAttribute("aria-pressed", "false")); }
    b.setAttribute("aria-pressed", "true"); form.hidden = false; err.hidden = true; refusedNote(); blankCard(); inp.focus();
  };
  const close = (restore) => {
    form.hidden = true;
    if (was && restore) { b.setAttribute("aria-pressed", "false"); was.forEach((x) => x.setAttribute("aria-pressed", "true")); }
    if (restore) restoreCard(); else card = null; // otherwise the page reads the newly chosen contract into the card
    was = null;
  };
  b.addEventListener("click", (e) => {
    if (!e.isTrusted && CONTRACTS.own) { was = null; card = null; return; } // our own programmatic click after "Use it": let the page switch
    if (CONTRACTS.own && !e.altKey && b.getAttribute("aria-pressed") !== "true") return;
    e.stopImmediatePropagation(); open();
  }, true);
  hint.querySelector("button").onclick = () => open();
  group.addEventListener("click", (e) => { const t = e.target.closest("button"); if (t && t !== b && !form.hidden) close(false); }, true);
  form.addEventListener("keydown", (e) => { if (e.key === "Escape") { close(true); b.focus(); } if (e.key === "Enter" && e.target === inp) use.click(); });
  cancel.onclick = () => close(true);
  use.onclick = async () => {
    const v = inp.value.trim().toLowerCase(); err.hidden = true;
    if (!isAccount(v)) { err.hidden = false; err.textContent = "That is not a NEAR account name."; return; }
    use.disabled = true; const real = await isClearToPay(v); use.disabled = false;
    if (!real) { err.hidden = false; err.textContent = `${v} is not a Clear to Pay contract this page can use: both NEAR servers must report our guard's exact code and no access keys. Check the address, or try again if NEAR was slow.`; return; }
    try { localStorage.setItem(OWN, v); } catch {}
    CONTRACTS.own = v; form.hidden = true; const sm = b.querySelector("small"); if (sm) sm.textContent = v;
    b.click();
  };
  return b;
}

// Phone keyboards capitalise the first letter of every box. Every box on these pages takes an id, an
// account, an amount or a code (lowercase or exact), so none may be changed by the keyboard. Messages
// people write are textareas and keep their capitals.
if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
  const calm = (root) => root.querySelectorAll?.('input:not([type]),input[type="text"],input[type="search"]').forEach((i) => {
    if (!i.hasAttribute("autocapitalize")) { i.setAttribute("autocapitalize", "none"); i.setAttribute("autocorrect", "off"); }
  });
  const go = () => { calm(document); new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.nodeType === 1 && (n.matches?.("input") ? calm(n.parentNode) : calm(n))))).observe(document.body, { childList: true, subtree: true }); };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", go) : go();
}

// ---------------------------------------------------------------- the Inbox badge: what arrived for the buyer and is not yet looked at
// Counts relay items (signatures, and details asking to be registered) this browser's Inbox has not pulled in yet, for our two
// contracts and the buyer's own. Shown to buyers only; suppliers and delivery signers have nothing waiting in an Inbox.
export const RELAY_SEEN = "ctp-inbox-relay-seen";
let badgeTimer = null;
export async function inboxBadge() {
  let role = null; try { role = localStorage.getItem("ctp-role"); } catch {}
  const links = [...document.querySelectorAll('a[href$="console/inbox/"], a[href$="../inbox/"], a[href="inbox/"]')];
  if (role === "signer" || role === "supplier" || !links.length || !RELAY.startsWith("https://")) return;
  if (!badgeTimer) {
    badgeTimer = setInterval(() => { if (!document.hidden) inboxBadge(); }, 30000);
    addEventListener("ctp-relay-seen", () => inboxBadge());
    document.addEventListener("visibilitychange", () => { if (!document.hidden) inboxBadge(); });
  }
  let seen; try { seen = new Set(JSON.parse(localStorage.getItem(RELAY_SEEN) || "[]")); } catch { seen = new Set(); }
  const per = {};
  await Promise.all(["demo", "live", CONTRACTS.own].filter(Boolean).map(async (net) => {
    try { per[net] = (await relayIds(net)).filter((id) => !seen.has(net + ":" + id)).length; } catch { per[net] = 0; }
  }));
  const n = Object.values(per).reduce((a, b) => a + b, 0);
  for (const a of links) {
    let el = a.querySelector(".nbadge");
    if (!n) { if (el) el.remove(); continue; }
    if (!el) { el = document.createElement("span"); el.className = "nbadge"; a.appendChild(el); }
    el.textContent = n > 9 ? "9+" : String(n); el.setAttribute("aria-label", `${n} new in the Inbox`);
  }
  // On the Inbox itself, each contract button shows its own count.
  for (const b of document.querySelectorAll(".switch button[data-c]")) {
    if (!/\/inbox\/$/.test(location.pathname)) break;
    const net = b.dataset.c === "own" ? CONTRACTS.own : b.dataset.c, k = per[net] || 0;
    let el = b.querySelector(".nbadge");
    if (!k) { if (el) el.remove(); continue; }
    if (!el) { el = document.createElement("span"); el.className = "nbadge"; b.appendChild(el); }
    el.textContent = k > 9 ? "9+" : String(k);
  }
}
