// Clear to Pay: the "New order" wizard on Buyer setup.
// Supplier → order lines → delivery signers → limits → review → ONE signed transaction.
// Filling fields never opens the wallet. The draft autosaves in this browser. The single
// transaction carries every owner call as an action, so NEAR applies all of it or none of it.
import * as C from "../crypto.js";
import { shareBox, MSG } from "../share.js";
import { rpc } from "../chain.js";
import { flagsFor, flagHtml, injectCss } from "../flags.js";
import { $, esc, short, signerNames, setSignerName, view, TX, USDC, isRef, isSupplierId, isRole, isAccount, isPubKey, toUnits, fromUnits, encodeLink, decodeLink, copy, alertLink, netOf } from "../chain.js";

// Gas per action, in Tgas. The sandbox test a_whole_order_is_set_up_in_one_signed_transaction_or_not_at_all
// sends this exact batch (a 50-line order) and prints what NEAR burned; keep the two in step.
export const WIZARD_GAS = { register_supplier: 20, add_delivery_signer: 15, create_order: 60, set_delivery_policy: 15, set_limits: 15 };
const MAX_TX_TGAS = 300, U64_MAX = (1n << 64n) - 1n, U128_MAX = (1n << 128n) - 1n, H72 = 72 * 3600 * 1000;
const STEPS = ["Supplier", "Order lines", "Delivery signers", "Limits", "Review"];
const blank = () => ({ v: 1, step: 1, back: false, max: 1,
  sup: { mode: "existing", id: "", key: "", addr: "", calledFor: "" },
  po: { id: "", lines: [{ sku: "", qty: "", price: "" }] },
  sig: { pick: [], add: [] },
  lim: { inv: "", per: "", hours: "", max: "" },
  done: null });

let K, D, X = null; // K: the page (S, contract, net, refresh, openAdvanced); D: the draft; X: what the chain holds now
const key = () => "ctp-order-draft:" + K.contract();
function load() { try { const d = JSON.parse(localStorage.getItem(key()) || "null"); return d && d.v === 1 ? { ...blank(), ...d } : blank(); } catch { return blank(); } }
// the orders signed from this browser, newest first: any of them can be reopened, and a new order started at any time
const hkey = () => "ctp-order-history:" + K.contract();
const pastOrders = () => { try { return JSON.parse(localStorage.getItem(hkey()) || "[]"); } catch { return []; } };
function remember(done) { try { localStorage.setItem(hkey(), JSON.stringify([done, ...pastOrders().filter((h) => h.plan.po !== done.plan.po)].slice(0, 10))); } catch {} }
function paintRecent() {
  const h = pastOrders(), box = $("wz-recent"); if (!box) return;
  if (!h.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="wz-recent"><b>Your recent orders</b><div class="row">${h.map((x, i) => `<button class="btn ghost sm ${D.done && D.done.plan.po === x.plan.po ? "on" : ""}" type="button" data-hist="${i}">${esc(x.plan.po)} · ${esc(usdUnits(x.plan.total))}</button>`).join("")}<button class="btn sm" type="button" id="wz-new2">+ New order</button></div></div>`;
  box.querySelectorAll("[data-hist]").forEach((b) => (b.onclick = () => { D = { ...blank(), done: h[+b.dataset.hist], step: 5, max: 5 }; save(); paint(); $("wiz").scrollIntoView({ block: "start" }); }));
  $("wz-new2").onclick = () => { if (D.done || confirm("Start a new order? The draft in this browser is cleared.")) { D = blank(); save(); paint(); } };
}
function save() { try { localStorage.setItem(key(), JSON.stringify(D)); $("wz-saved").textContent = "Draft saved in this browser"; } catch { $("wz-saved").textContent = "This browser would not keep the draft"; } }
/** A refusal says what is wrong and how to fix it, and names the box it is about (the page jumps there). */
const fail = (step, m, field) => { const e = new Error(m); e.step = step; e.field = field; throw e; };
const shown = (v) => (String(v).length > 40 ? String(v).slice(0, 40) + "…" : String(v));
const usdUnits = (u) => fromUnits(u) + " USDC";
const whenText = (ms) => new Date(ms).toLocaleString([], { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

// ---------------------------------------------------------------- what the chain holds
async function snapshot() {
  const c = K.contract();
  const [ids, signers, limits] = await Promise.all([view(c, "get_supplier_ids"), view(c, "get_delivery_signers"), view(c, "get_limits")]);
  const sups = (await Promise.all(ids.slice(0, 100).map((id) => view(c, "get_supplier", { supplier_id: id }).catch(() => null)))).filter(Boolean);
  X = { suppliers: sups.map((s) => ({ id: s.supplier_id, key: s.signing_key, addr: s.route_on_file.address, payable: !!s.payable_route, from: Number(BigInt(s.route_payable_from) / 1_000_000n) })), signers, limits };
  if (!D.lim.inv && BigInt(limits.per_invoice) > 0n) D.lim = { inv: fromUnits(limits.per_invoice), per: fromUnits(limits.per_supplier_per_period), hours: String(limits.period_hours), max: String(limits.max_submissions_per_day || 100) };
}

// ---------------------------------------------------------------- the plan: exactly what will be signed
export function plan(d, x, contract) {
  const supKeys = new Set(x.suppliers.map((s) => s.key)), sigKeys = new Set(x.signers.map((s) => s.key));
  // 1. supplier
  let sup;
  if (d.sup.mode === "existing") {
    sup = x.suppliers.find((s) => s.id === d.sup.id) || fail(1, "Pick a supplier from the list, or switch to New supplier and add one.", "wz-sid");
  } else {
    const id = d.sup.id.trim(), k = d.sup.key.trim(), a = d.sup.addr.trim();
    if (!id) fail(1, "Type a short id for this supplier, for example acme-steel. It's how the contract names them.", "wz-sid");
    if (!isSupplierId(id)) fail(1, `“${shown(id)}” can't be a supplier id. Use lowercase letters, digits and - _ . only, no spaces, up to 64 characters. Example: acme-steel.`, "wz-sid");
    if (x.suppliers.some((s) => s.id === id)) fail(1, `${id} is already registered on this contract. Switch to Registered supplier and pick it from the list.`, "wz-sid");
    if (!k) fail(1, "The supplier's signing key is missing. Send them the invitation (button below), then paste their reply: it fills the key for you.", "wz-skey");
    if (!isPubKey(k)) fail(1, "That isn't a signing key. It starts with ed25519: followed by 43–44 letters and digits. Paste the supplier's reply instead of typing it.", "wz-skey");
    if (supKeys.has(k)) fail(1, "That key already belongs to another supplier. Each supplier needs its own: send this supplier the invitation so their phone makes one.", "wz-skey");
    if (sigKeys.has(k)) fail(1, "That key belongs to one of your delivery signers. A supplier needs its own key: send them the invitation.", "wz-skey");
    if (!a) fail(1, "Type the NEAR account the supplier will be paid to, for example acme.testnet.", "wz-saddr");
    if (!isAccount(a)) fail(1, `“${shown(a)}” isn't a NEAR account. It looks like name.testnet (or a 64-character hex address), lowercase, no spaces. Copy it from the supplier's reply.`, "wz-saddr");
    if (d.sup.calledFor !== `${a}|${k}`) fail(1, "Call the supplier on a number you already had and ask them to read this payout address back to you. Then tick that you called them.", "wz-called");
    sup = { id, key: k, addr: a, isNew: true, from: Date.now() + H72 };
  }
  // 2. order lines
  const po = d.po.id.trim();
  if (!isRef(po)) fail(2, po ? `“${shown(po)}” can't be an order number. Use letters, digits and - _ . / only, no spaces, up to 64 characters. Example: PO-1184.` : "Give the order a number, for example PO-1184.", "wz-po");
  const rows = d.po.lines.map((l, i) => ({ ...l, i })).filter((l) => l.sku.trim() || l.qty.trim() || l.price.trim());
  if (!rows.length) fail(2, "Add at least one line: the item code, how many, and the price for one.", '[data-l="0"][data-f="sku"]');
  if (rows.length > 50) fail(2, "An order holds at most 50 lines. Split it into two orders.");
  const lines = rows.map((l, n) => {
    const sku = l.sku.trim(), qty = l.qty.trim(), u = toUnits(l.price);
    const at = (f) => `[data-l="${l.i}"][data-f="${f}"]`;
    if (!sku) fail(2, `Line ${n + 1}: type the item code, the same one the supplier will put on the invoice (for example AH36-12mm).`, at("sku"));
    if (!isRef(sku)) fail(2, `Line ${n + 1}: “${shown(sku)}” can't be an item code. Use letters, digits and - _ . / only, no spaces.`, at("sku"));
    if (!/^[1-9]\d{0,19}$/.test(qty) || BigInt(qty) > U64_MAX) fail(2, `Line ${n + 1}: the quantity must be a whole number above 0, like 10. No decimals, commas or units.`, at("qty"));
    if (!u || u === "0" || BigInt(u) > U128_MAX) fail(2, `Line ${n + 1}: the price is in USDC for one item, above 0, with up to 6 decimals, like 7.80. No $ sign or commas.`, at("price"));
    return { sku, qty, unit_price: u };
  });
  if (new Set(lines.map((l) => l.sku)).size !== lines.length) fail(2, "The same item code is on two lines. Put it on one line with the total quantity.");
  const total = lines.reduce((t, l) => t + BigInt(l.qty) * BigInt(l.unit_price), 0n);
  if (total > U128_MAX) fail(2, "The order total is too large for the contract. Split it into smaller orders.");
  // 3. delivery signers
  const picked = x.signers.filter((s) => d.sig.pick.includes(s.key));
  const added = d.sig.add.filter((s) => s.key.trim() || s.role.trim()).map((s, n) => {
    const k = s.key.trim(), r = s.role.trim();
    if (!isPubKey(k)) fail(3, `New signer ${n + 1}: that isn't a signing key (ed25519: then 43–44 letters and digits). Send that person the invitation and paste their reply.`, `[data-a="${n}"][data-f="key"]`);
    if (!isRole(r)) fail(3, `New signer ${n + 1}: the role is one lowercase word like storekeeper or weighbridge (letters, digits, -), no spaces.`, `[data-a="${n}"][data-f="role"]`);
    if (sigKeys.has(k)) fail(3, `New signer ${n + 1} is already registered. Tick it in the list above instead of adding it again.`, `[data-a="${n}"][data-f="key"]`);
    if (supKeys.has(k) || k === sup.key) fail(3, `New signer ${n + 1}'s key belongs to a supplier. A delivery signer needs their own key: send them the invitation.`, `[data-a="${n}"][data-f="key"]`);
    return { key: k, role: r };
  });
  if (new Set(added.map((s) => s.key)).size !== added.length) fail(3, "The same new key is listed twice. Remove one of them.");
  if (x.signers.length + added.length > 20) fail(3, "A contract holds at most 20 delivery signers. Reuse the registered ones by ticking them.");
  const roles = [...new Set([...picked, ...added].map((s) => s.role))];
  if (roles.length < 2) fail(3, "Pick signers in at least two different roles, for example a storekeeper and a weighbridge. Two people in the same role don't count as two checks.", "wz-roles");
  if (roles.length > 5) fail(3, "An order can ask for at most 5 roles. Untick some.", "wz-roles");
  // 4. limits
  const inv = toUnits(d.lim.inv), per = toUnits(d.lim.per), hours = String(d.lim.hours).trim(), maxs = String(d.lim.max).trim();
  if (!inv || !per || inv === "0") fail(4, "Both limits are USDC amounts above 0, like 500 or 1200.50. No $ sign or commas.", !inv || inv === "0" ? "wz-linv" : "wz-lper");
  if (BigInt(inv) > BigInt(per)) fail(4, "The limit for one invoice cannot be above the limit for the whole period. Raise the period limit or lower the single-invoice one.", "wz-linv");
  if (!/^\d{1,4}$/.test(hours) || +hours < 1 || +hours > 8784) fail(4, "The period is in hours, a whole number from 1 to 8784 (one year). 720 is about a month.", "wz-lh");
  if (!/^\d{1,4}$/.test(maxs) || +maxs < 1 || +maxs > 1000) fail(4, "Submissions per day is a whole number from 1 to 1000.", "wz-lmax");
  const L = x.limits, limitsChanged = inv !== String(L.per_invoice) || per !== String(L.per_supplier_per_period) || hours !== String(L.period_hours) || +maxs !== +(L.max_submissions_per_day || 0);
  // the transaction
  const actions = [];
  if (sup.isNew) actions.push(["register_supplier", { supplier_id: sup.id, signing_key: sup.key, route: { chain: "near", token: USDC, address: sup.addr } }]);
  for (const s of added) actions.push(["add_delivery_signer", { key: s.key, role: s.role }]);
  actions.push(["create_order", { order_id: po, supplier_id: sup.id, token: USDC, lines }]);
  actions.push(["set_delivery_policy", { order_id: po, required: 2, roles }]);
  if (limitsChanged) actions.push(["set_limits", { per_invoice: inv, per_supplier_per_period: per, period_hours: hours, max_submissions_per_day: +maxs }]);
  const tgas = actions.reduce((t, [m]) => t + WIZARD_GAS[m], 0);
  if (tgas > MAX_TX_TGAS) fail(3, `This would be too big for one NEAR transaction (${tgas} of ${MAX_TX_TGAS} Tgas). Add fewer new signers now; register the rest with the next order.`);
  return { contract, sup, po, lines, total: total.toString(), picked, added, roles, limits: { inv, per, hours, max: +maxs, changed: limitsChanged }, actions, tgas };
}
export const walletActions = (p) => p.actions.map(([m, args]) => ({ type: "FunctionCall", params: { methodName: m, args, gas: (BigInt(WIZARD_GAS[m]) * 10n ** 12n).toString(), deposit: "1" } }));

// ---------------------------------------------------------------- the supplier's proof of their payout address (NEP-413), optional
// Checked here, in this browser: the message names this supplier, key, address and contract; the signature is valid;
// it was made by a FULL-ACCESS key of the payout account (read live from NEAR). The contract does not check it.
const proofCache = new Map();
export async function checkProof(sup, contract) {
  const pr = sup.proof;
  if (!pr) return { state: "none" };
  const id = JSON.stringify([sup.id, sup.key, sup.addr, contract, pr]);
  if (proofCache.has(id)) return proofCache.get(id);
  let r;
  try {
    const message = C.payoutProofText({ address: sup.addr.trim(), supplier_id: sup.id.trim(), contract, key: sup.key.trim(), at: pr.at });
    if (pr.account !== sup.addr.trim()) r = { state: "bad", why: `signed by ${pr.account}, not by ${sup.addr.trim()}` };
    else if (!C.verifyNep413({ publicKey: pr.publicKey, signature: pr.signature, message, nonce: C.base64.decode(pr.nonce), recipient: contract, callbackUrl: pr.callbackUrl }))
      r = { state: "bad", why: "the signature does not match this supplier, key, address and contract" };
    else {
      let ak = null; try { ak = await rpc("query", { request_type: "view_access_key", finality: "final", account_id: sup.addr.trim(), public_key: pr.publicKey }); } catch {}
      const t = Date.parse(pr.at), age = Date.now() - t;
      r = !Number.isFinite(t) || age < -10 * 60_000 ? { state: "bad", why: "its time is in the future" }
        : age > 7 * 24 * 3600_000 ? { state: "bad", why: "it is more than 7 days old; ask the supplier to prove the address again" }
        : ak && ak.permission === "FullAccess" ? { state: "ok", at: pr.at } : { state: "bad", why: ak ? "signed with a limited key, not a full-access key of the account" : `the signing key is not a key of ${sup.addr.trim()} (or NEAR could not be reached)` };
    }
  } catch { r = { state: "bad", why: "the proof is damaged" }; }
  proofCache.set(id, r); return r;
}
const proofLine = (r) => r.state === "ok" ? `<span class="proved">Proved by the account itself</span> (NEP-413, signed ${esc(new Date(r.at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }))}; checked in this browser, not by the contract)`
  : r.state === "bad" ? `<span class="unproved">Proof does not check out:</span> ${esc(r.why)}. Rely on the phone call only, and ask why.` : `No proof from the account (optional). The phone call is what counts.`;

// ---------------------------------------------------------------- invitation replies
function readReply(text) {
  const t = String(text).trim(); let o;
  const m = /[#&?]a=([A-Za-z0-9_-]+)/.exec(t);
  try { o = m ? decodeLink(m[1]) : t.startsWith("{") ? JSON.parse(t) : decodeLink(t); } catch { throw new Error("That is not a reply from a Clear to Pay invitation."); }
  if (!o || !isPubKey(o.key)) throw new Error("The reply has no valid key.");
  if (o.contract && o.contract !== K.contract()) throw new Error(`That reply is for ${o.contract}; switch to it at the top first.`);
  return o;
}
function inviteLink(j) { return new URL("../sign/#j=" + encodeLink({ contract: K.contract(), ...j }), location.href).href; }
function showLink(box, link, label, msg = "", subject = "Clear to Pay") { shareBox(box, link, { msg, subject, copyLabel: label }); }
export function rolePageLink(role, roleName, order) {
  const q = new URLSearchParams({ r: role, c: netOf(K.contract()) || "demo" }); if (roleName) q.set("as", roleName); if (order) q.set("o", order);
  const u = new URL("../sign/#" + q.toString(), location.href);
  if (q.get("c") === "own") u.search = "?contract=" + encodeURIComponent(K.contract()); // their browser learns the company's own contract
  return u.href;
}

// ---------------------------------------------------------------- the steps
function stepper() {
  $("wz-steps").innerHTML = STEPS.map((s, i) => `<li><button type="button" data-go="${i + 1}" ${i + 1 > D.max && !D.done ? "disabled" : ""} ${D.step === i + 1 ? 'aria-current="step"' : ""}><b>${i + 1}</b>${esc(s)}</button></li>`).join("");
  $("wz-steps").querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(+b.dataset.go)));
}
function go(n) { D.step = n; D.max = Math.max(D.max, n); save(); paint(); $("wiz").scrollIntoView({ block: "start", behavior: "smooth" }); }
const field = (id, label, hint, value, attrs = "") => `<label>${esc(label)}${hint ? `<span>${esc(hint)}</span>` : ""}<input id="${id}" value="${esc(value)}" autocomplete="off" spellcheck="false" autocapitalize="none" autocorrect="off" ${attrs}></label>`;

function paintSupplier(b) {
  const s = D.sup, opts = X.suppliers.map((x) => `<option value="${esc(x.id)}" ${x.id === s.id ? "selected" : ""}>${esc(x.id)} → ${esc(x.addr)}${x.payable ? "" : " (in its 72-hour wait)"}</option>`).join("");
  b.innerHTML = `<div class="seg" role="radiogroup" aria-label="Supplier">
      <label><input type="radio" name="wz-sm" value="existing" ${s.mode === "existing" ? "checked" : ""} ${X.suppliers.length ? "" : "disabled"}> A registered supplier</label>
      <label><input type="radio" name="wz-sm" value="new" ${s.mode === "new" ? "checked" : ""}> A new supplier</label></div>
    <div id="wz-sx"></div>`;
  const sx = $("wz-sx");
  if (s.mode === "existing" && X.suppliers.length) {
    if (!X.suppliers.some((x) => x.id === s.id)) s.id = X.suppliers[0].id;
    const cur = X.suppliers.find((x) => x.id === s.id);
    sx.innerHTML = `<div class="fields"><label>Supplier<select id="wz-sid">${opts}</select></label></div>
      <p class="note">Paid only to <b>${esc(cur.addr)}</b>, ${cur.payable ? "payable now" : "payable from " + esc(whenText(cur.from))}. Changing it needs the supplier's signed request, your approval and 72 hours.</p>`;
    $("wz-sid").onchange = (e) => { s.id = e.target.value; save(); paint(); };
  } else {
    if (s.mode !== "new") s.mode = "new";
    const ok = s.calledFor === `${s.addr.trim()}|${s.key.trim()}` && s.addr.trim();
    sx.innerHTML = `<div class="two">
      <div class="fields">
        <label>Paste the supplier's reply<span>the link they sent back after your invitation</span><textarea id="wz-sreply" rows="3" placeholder="https://…/console/setup/#a=…"></textarea></label>
        <div class="row" style="margin-top:0"><button class="btn ghost" type="button" id="wz-suse">Use this reply</button></div>
        ${field("wz-sid", "Supplier id", "a-z, 0-9, '-', '_', '.'", s.id)}
        ${field("wz-skey", "Their public signing key", "public key from their phone; ed25519:…", s.key)}
        ${field("wz-saddr", "Their payout account on NEAR", "where they will be paid", s.addr)}
        <label class="confirm big"><input type="checkbox" id="wz-called" ${ok ? "checked" : ""}> I called the supplier on a number I already had, and they read this address back to me: <b id="wz-caddr">${esc(s.addr.trim() || "this address")}</b>.</label>
        <div id="wz-flag" aria-live="polite"></div>
        <p class="note" id="wz-proof">${s.proof ? "Checking the address proof…" : proofLine({ state: "none" })}</p>
        <p class="note">Payable from <b>${esc(whenText(Date.now() + H72))}</b> at the earliest: every new address waits 72 hours.</p>
      </div>
      <div class="invbox"><b>No reply yet?</b><p class="muted">Send the supplier an invitation. They open it on their phone, a key is made there, and they send you a reply to paste here.</p>
        <div class="row" style="margin-top:0"><button class="btn" type="button" id="wz-sinv">Make the supplier's invitation</button></div><div id="wz-sinvout"></div></div></div>`;
    const bind = (id, f) => ($(id).oninput = (e) => { s[f] = e.target.value; if (f !== "id") { s.calledFor = ""; $("wz-called").checked = false; } if (f === "addr") $("wz-caddr").textContent = s.addr.trim() || "this address"; save(); });
    bind("wz-sid", "id"); bind("wz-skey", "key"); bind("wz-saddr", "addr");
    for (const k of ["wz-sid", "wz-saddr"]) $(k).addEventListener("blur", (e) => { const v = e.target.value.trim().toLowerCase(); if (v !== e.target.value) { e.target.value = v; e.target.dispatchEvent(new Event("input")); } });
    // An address named in a seized invoice: a warning with the receipts, never a block (flags.js).
    injectCss();
    let ft; const flag = () => { clearTimeout(ft); ft = setTimeout(async () => { const a = s.addr.trim(), h = await flagsFor(a); if ($("wz-flag") && s.addr.trim() === a) $("wz-flag").innerHTML = flagHtml(a, h); }, 300); };
    $("wz-saddr").addEventListener("input", flag); flag();
    $("wz-called").onchange = (e) => { s.calledFor = e.target.checked ? `${s.addr.trim()}|${s.key.trim()}` : ""; save(); paint(); };
    $("wz-suse").onclick = () => { try { const o = readReply($("wz-sreply").value); if (o.kind && o.kind !== "supplier") throw new Error("That is a delivery signer's reply; paste it at step 3."); s.key = o.key; if (o.supplier_id) s.id = o.supplier_id; if (o.address) s.addr = o.address; s.proof = o.proof || null; s.calledFor = ""; save(); paint(); msg("Reply read. Now call the supplier and check the address."); } catch (e) { msg(e.message, true); } };
    if (s.proof) checkProof(s, K.contract()).then((r) => { const el = $("wz-proof"); if (el) el.innerHTML = proofLine(r); });
    $("wz-sinv").onclick = () => {
      const el = $("wz-sid"), id = el.value.trim().toLowerCase();
      if (id !== el.value) { el.value = id; s.id = id; save(); } // phone keyboards capitalise the first letter
      if (!isSupplierId(id)) { msg(id ? `“${id}” can't be a supplier id: use a-z, 0-9, '-', '_' or '.' only, no spaces.` : "Type the supplier id first (a-z, 0-9, '-', '_', '.').", true); el.scrollIntoView({ block: "center", behavior: "smooth" }); el.focus({ preventScroll: true }); return; } s.id = id; save(); showLink($("wz-sinvout"), inviteLink({ kind: "supplier", supplier_id: id }), "Copy the invitation", MSG.inviteSupplier(id), "Join as our supplier on Clear to Pay"); };
  }
  b.querySelectorAll('input[name="wz-sm"]').forEach((r) => (r.onchange = () => { s.mode = r.value; s.id = ""; save(); paint(); }));
}
function paintLines(b) {
  const p = D.po;
  if (!p.id) p.id = "PO-" + new Date().toISOString().slice(2, 10).replace(/-/g, "") + "-" + Math.floor(Math.random() * 900 + 100);
  let total = 0n;
  const rows = p.lines.map((l, i) => {
    const u = toUnits(l.price), ok = u && /^[1-9]\d{0,19}$/.test(l.qty.trim());
    if (ok) total += BigInt(l.qty.trim()) * BigInt(u);
    return `<div class="lrow3"><input aria-label="Item ${i + 1}" data-l="${i}" data-f="sku" value="${esc(l.sku)}" placeholder="AH36-12mm"><input aria-label="Quantity ${i + 1}" data-l="${i}" data-f="qty" value="${esc(l.qty)}" inputmode="numeric" placeholder="30"><input aria-label="Unit price ${i + 1} in USDC" data-l="${i}" data-f="price" value="${esc(l.price)}" inputmode="decimal" placeholder="0.78"><button type="button" class="x" data-rm="${i}" aria-label="Remove line ${i + 1}">×</button>
      <small>${u ? `${esc(fromUnits(u))} USDC = <code>${esc(u)}</code> units` : "&nbsp;"}</small></div>`;
  }).join("");
  b.innerHTML = `<div class="fields">${field("wz-po", "Order number", "your purchase order reference", p.id)}
    <div class="linegrid"><div class="lhead w3"><span>Item</span><span>Quantity</span><span>Unit price (USDC)</span><span></span></div>${rows}</div>
    <div class="row" style="margin-top:0"><button class="btn ghost" type="button" id="wz-add">Add a line</button><span class="tot">Total <b id="wz-tot">${esc(fromUnits(total))} USDC</b></span></div></div>`;
  $("wz-po").oninput = (e) => { p.id = e.target.value; save(); };
  b.querySelectorAll("[data-l]").forEach((inp) => (inp.oninput = (e) => { p.lines[+inp.dataset.l][inp.dataset.f] = e.target.value; save(); const sm = inp.parentElement.querySelector("small"), l = p.lines[+inp.dataset.l], u = toUnits(l.price); sm.innerHTML = u ? `${esc(fromUnits(u))} USDC = <code>${esc(u)}</code> units` : "&nbsp;"; let t = 0n; for (const x of p.lines) { const v = toUnits(x.price); if (v && /^[1-9]\d{0,19}$/.test(x.qty.trim())) t += BigInt(x.qty.trim()) * BigInt(v); } $("wz-tot").textContent = fromUnits(t) + " USDC"; }));
  b.querySelectorAll("[data-rm]").forEach((x) => (x.onclick = () => { p.lines.splice(+x.dataset.rm, 1); if (!p.lines.length) p.lines.push({ sku: "", qty: "", price: "" }); save(); paint(); }));
  $("wz-add").onclick = () => { if (p.lines.length < 50) { p.lines.push({ sku: "", qty: "", price: "" }); save(); paint(); } };
}
function paintSigners(b) {
  const g = D.sig;
  const NM = signerNames(K.contract()), nm = (k) => NM[k.trim()] || "";
  const list = X.signers.map((s) => `<div class="pickrow"><label class="pk"><input type="checkbox" data-pick="${esc(s.key)}" ${g.pick.includes(s.key) ? "checked" : ""}><span><b>${esc(s.role)}${nm(s.key) ? ` <i class="nick">${esc(nm(s.key))}</i>` : ""}</b><small>${esc(short(s.key, 10))} · registered</small></span></label><input class="nickin" data-nick="${esc(s.key)}" value="${esc(nm(s.key))}" placeholder="Name (only you see it)" aria-label="Your name for this ${esc(s.role)}" maxlength="40" autocomplete="off"></div>`).join("");
  const adds = g.add.map((s, i) => `<div class="lrow2 n3"><input aria-label="New signer ${i + 1} key" data-a="${i}" data-f="key" value="${esc(s.key)}" placeholder="ed25519:…"><input aria-label="New signer ${i + 1} role" data-a="${i}" data-f="role" value="${esc(s.role)}" placeholder="weighbridge"><input aria-label="New signer ${i + 1} name" data-nick="${esc(s.key.trim())}" data-an="${i}" value="${esc(nm(s.key))}" placeholder="Musa" maxlength="40" autocomplete="off"><button type="button" class="x" data-arm="${i}" aria-label="Remove new signer ${i + 1}">×</button></div>`).join("");
  // a new signer joins the list as soon as its key and role are complete, tagged NEW until the order's transaction registers it
  const newRows = () => g.add.filter((s) => isPubKey(s.key.trim()) && isRole(s.role.trim())).map((s) => `<div class="pickrow new"><input type="checkbox" checked disabled aria-label="New signer, included"><span><b>${esc(s.role.trim())}${nm(s.key) ? ` <i class="nick">${esc(nm(s.key))}</i>` : ""} <em class="tag">new</em></b><small>${esc(short(s.key.trim(), 10))} · registered when you approve this order</small></span></div>`).join("");
  const rolesNote = () => { const roles = [...new Set([...X.signers.filter((s) => g.pick.includes(s.key)), ...g.add.filter((s) => isRole(s.role.trim()))].map((s) => s.role.trim()))];
    return roles.length >= 2 ? `Delivery needs 2 signatures, from 2 of these roles: <b>${esc(roles.join(", "))}</b>.` : `Roles so far: ${esc(roles.join(", ") || "none")}. Two different roles are needed.`; };
  const nr = newRows();
  b.innerHTML = `<div class="two"><div class="fields">
      ${X.signers.length || g.add.length ? `<div class="picks"><span class="muted" style="font:400 12.5px var(--mono)">${X.signers.length ? "Signers: tick who confirms this order's deliveries" : "Signers for this order"}</span>${list}<div class="picks" id="wz-picknew">${nr}</div></div>` : `<p class="muted">No delivery signers registered yet. Add two below, in two different roles.</p>`}
      <label>Paste a signer's reply<span>the link a storekeeper or weighbridge sent back</span><textarea id="wz-greply" rows="2" placeholder="https://…/console/setup/#a=…"></textarea></label>
      <div class="row" style="margin-top:0"><button class="btn ghost" type="button" id="wz-guse">Use this reply</button><button class="btn ghost" type="button" id="wz-gadd">Add a key by hand</button></div>
      ${adds ? `<div class="linegrid"><span class="muted" style="font:400 12.5px var(--body)">New signers, registered by this order's transaction</span><div class="lhead w2 n3"><span>Public key</span><span>Role</span><span>Name, for you</span><span></span></div>${adds}</div>` : ""}
      <p class="note" id="wz-roles">${rolesNote()}</p></div>
    <div class="invbox"><b>Invite a signer</b><p class="muted">Their phone makes the key. Register a key only if you sent that person the invitation.</p>
      <div class="fields" style="margin-top:0"><label>Role<input id="wz-grole" placeholder="weighbridge" autocomplete="off"></label></div>
      <div class="row" style="margin-top:0"><button class="btn" type="button" id="wz-ginv">Make the invitation</button></div><div id="wz-ginvout"></div></div></div>`;
  b.querySelectorAll("[data-pick]").forEach((c) => (c.onchange = () => { const k = c.dataset.pick; g.pick = c.checked ? [...new Set([...g.pick, k])] : g.pick.filter((x) => x !== k); save(); paint(); }));
  b.querySelectorAll("[data-a]").forEach((inp) => (inp.oninput = (e) => { g.add[+inp.dataset.a][inp.dataset.f] = e.target.value; save();
    const box = $("wz-picknew"); if (box) box.innerHTML = newRows(); // typed by hand: the row appears once key and role are complete
    $("wz-roles").innerHTML = rolesNote(); }));
  b.querySelectorAll("[data-arm]").forEach((x) => (x.onclick = () => { g.add.splice(+x.dataset.arm, 1); save(); paint(); }));
  // names are this browser's labels: saved as typed, keyed by the public key, never part of the transaction
  b.querySelectorAll("[data-nick]").forEach((inp) => (inp.oninput = () => { const k = inp.dataset.an != null ? g.add[+inp.dataset.an].key.trim() : inp.dataset.nick; if (isPubKey(k)) setSignerName(K.contract(), k, inp.value); const box = $("wz-picknew"); if (box && inp.dataset.an != null) box.innerHTML = newRows(); }));
  $("wz-gadd").onclick = () => { g.add.push({ key: "", role: "" }); save(); paint(); };
  $("wz-guse").onclick = () => { try { const o = readReply($("wz-greply").value); if (o.kind === "supplier") throw new Error("That is the supplier's reply; it belongs at step 1."); if (X.signers.some((s) => s.key === o.key)) { g.pick = [...new Set([...g.pick, o.key])]; } else if (!g.add.some((s) => s.key === o.key)) g.add.push({ key: o.key, role: isRole(o.role) ? o.role : "" }); save(); paint(); msg("Signer added. Register a key only if you sent that person the invitation."); } catch (e) { msg(e.message, true); } };
  $("wz-ginv").onclick = () => { const r = $("wz-grole").value.trim(); if (!isRole(r)) { msg("Role: 1 to 32 of a-z, 0-9, '-'.", true); return; } showLink($("wz-ginvout"), inviteLink({ kind: "signer", role: r }), "Copy the invitation", MSG.inviteSigner(r), "Confirm deliveries with Clear to Pay"); };
}
function paintLimits(b) {
  const l = D.lim, L = X.limits, set = BigInt(L.per_invoice) > 0n;
  b.innerHTML = `<p class="muted">${set ? `Now on chain: ${esc(usdUnits(L.per_invoice))} per invoice · ${esc(usdUnits(L.per_supplier_per_period))} per supplier every ${esc(String(L.period_hours))} h · ${esc(String(L.max_submissions_per_day))} submissions a day. Change them only if this order needs it; unchanged limits are not part of the transaction.` : "No limits are set yet, so nothing could clear. Set them now; they become part of this order's transaction."}</p>
    <div class="fields grid2">${field("wz-linv", "Largest single invoice", "USDC", l.inv, 'inputmode="decimal"')}${field("wz-lper", "Most per supplier per period", "USDC", l.per, 'inputmode="decimal"')}
      ${field("wz-lh", "Period", "hours, 1 to 8784", l.hours, 'inputmode="numeric"')}${field("wz-lmax", "Most submissions per day", "1 to 1000, any verdict", l.max, 'inputmode="numeric"')}</div>`;
  [["wz-linv", "inv"], ["wz-lper", "per"], ["wz-lh", "hours"], ["wz-lmax", "max"]].forEach(([id, f]) => ($(id).oninput = (e) => { l[f] = e.target.value; save(); }));
}
function section(n, title, body) { return `<section class="rv"><div class="rv-h"><h4>${esc(title)}</h4>${D.done ? "" : `<button class="btn ghost sm" type="button" data-edit="${n}">Edit</button>`}</div>${body}</section>`; }
function reviewHTML(p) {
  const sup = p.sup;
  return section(1, "Supplier", `<dl class="kv2"><dt>Supplier</dt><dd>${esc(sup.id)}${sup.isNew ? ' <em class="tag">new</em>' : ""}</dd><dt>Paid only to</dt><dd><b>${esc(sup.addr)}</b></dd><dt>Payable from</dt><dd>${esc(sup.isNew ? whenText(Date.now() + H72) + " (72 hours after signing)" : whenText(sup.from))}</dd>${sup.isNew ? `<dt>Signing key</dt><dd><code>${esc(short(sup.key, 12))}</code></dd><dt>Address check</dt><dd>You called them and they read it back<br>${proofLine(sup.proofResult || { state: "none" })}</dd>` : ""}</dl>`)
    + section(2, `Order ${p.po}`, `<table class="lt"><thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Units</th><th>Line total</th></tr></thead><tbody>${p.lines.map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.qty)}</td><td>${esc(fromUnits(l.unit_price))} USDC</td><td><code>${esc(l.unit_price)}</code></td><td>${esc(fromUnits((BigInt(l.qty) * BigInt(l.unit_price)).toString()))} USDC</td></tr>`).join("")}</tbody><tfoot><tr><td colspan="4">Total</td><td><b>${esc(usdUnits(p.total))}</b></td></tr></tfoot></table>`)
    + section(3, "Delivery", `<dl class="kv2"><dt>Rule</dt><dd>2 signatures, from 2 different roles of: <b>${esc(p.roles.join(", "))}</b></dd>${[...p.picked.map((s) => [s, "registered"]), ...p.added.map((s) => [s, "new"])].map(([s, t]) => `<dt>${esc(s.role)}</dt><dd>${signerNames(K.contract())[s.key] ? `<b>${esc(signerNames(K.contract())[s.key])}</b> ` : ""}<code>${esc(short(s.key, 10))}</code> <em class="tag ${t === "registered" ? "reg" : ""}">${t}</em></dd>`).join("")}</dl>`)
    + section(4, "Limits", `<dl class="kv2"><dt>Per invoice</dt><dd>${esc(usdUnits(p.limits.inv))}</dd><dt>Per supplier</dt><dd>${esc(usdUnits(p.limits.per))} every ${esc(p.limits.hours)} h</dd><dt>Submissions a day</dt><dd>${esc(String(p.limits.max))}</dd><dt></dt><dd class="muted">${p.limits.changed ? "These replace the limits on chain." : "Unchanged: not part of the transaction."}</dd></dl>`);
}
async function paintReview(b) {
  let p;
  try { await snapshot(); } catch {} // CTP8-02: review what the contract holds now, not when the wizard opened
  try { p = plan(D, X, K.contract()); if (p.sup.isNew) p.sup.proofResult = await checkProof(D.sup, K.contract()); } catch (e) { b.innerHTML = `<p class="err">${esc(e.message)}</p><div class="row"><button class="btn" type="button" id="wz-fix">Go to step ${e.step}</button></div>`; $("wz-fix").onclick = () => go(e.step); return; }
  const owner = K.S.owner, me = K.S.me, can = me && owner && me === owner;
  b.innerHTML = `${reviewHTML(p)}
    <section class="rv tx"><div class="rv-h"><h4>Your wallet will sign one transaction</h4></div>
      <p>To <b>${esc(K.contract())}</b>, from <b>${esc(me || owner || "the buyer")}</b>, ${p.actions.length} actions, each with 1 yoctoNEAR (it proves it is you) and its own gas, ${p.tgas} Tgas in all:</p>
      <ol class="acts2">${p.actions.map(([m, a]) => `<li><code>${esc(m)}</code> <span class="muted">${esc(m === "create_order" ? `${a.order_id}, ${a.lines.length} line${a.lines.length > 1 ? "s" : ""}` : m === "register_supplier" ? `${a.supplier_id} → ${a.route.address}` : m === "add_delivery_signer" ? `${a.role} ${short(a.key, 6)}` : m === "set_delivery_policy" ? `2 of ${a.roles.join(", ")}` : "new limits")}</span> · ${WIZARD_GAS[m]} Tgas</li>`).join("")}</ol>
      <p class="atomic"><b>All of it lands, or none of it does.</b> NEAR runs the actions of one transaction together: if the contract refuses any of them, none of the others take effect.</p>
      <details><summary>The exact arguments</summary><pre class="preview">${esc(JSON.stringify(p.actions.map(([m, a]) => ({ method: m, args: a, gas_tgas: WIZARD_GAS[m], deposit_yocto: "1" })), null, 2))}</pre></details></section>
    <div class="row"><button class="btn ghost" type="button" id="wz-po-dl">Download PO (draft)</button><button class="btn y big" type="button" id="wz-sign" ${can ? "" : "disabled"}>Sign once</button></div>
    ${can ? "" : `<p class="err">${me ? `Only the buyer account can sign this (${esc(owner)}).` : "Connect the buyer's wallet at the top to sign."}</p>`}
    <p class="note">Topping up the pool and the agent's key go to other receivers (the token contract, your own account), so they stay separate approvals, after this one, under Advanced.</p>`;
  b.querySelectorAll("[data-edit]").forEach((x) => (x.onclick = () => { D.back = true; go(+x.dataset.edit); }));
  $("wz-po-dl").onclick = () => printPO(p, null);
  $("wz-sign").onclick = () => signOnce(p);
}
function paintDone(b) {
  const d = D.done, p = d.plan;
  const roleLinks = p.roles.map((r) => `<button class="btn ghost" type="button" data-rl="${esc(r)}">Send the ${esc(r)} their page</button>`).join("");
  b.innerHTML = `<div class="okline big"><b>${esc(p.po)} is authorised on chain.</b> ${esc(usdUnits(p.total))} to ${esc(p.sup.id)}, paid only to ${esc(p.sup.addr)}.</div>
    <div class="row"><a class="btn" href="${TX(d.hash)}" target="_blank" rel="noopener">The transaction on NearBlocks</a><button class="btn y" type="button" id="wz-po-dl2">Download PO</button></div>
    <div class="now" id="wz-back">Reading it back from the contract…</div>
    <h4 class="h4">Next</h4>
    <div class="row" style="margin-top:0"><button class="btn ghost" type="button" id="wz-rsup">Send ${esc(p.po)} to the supplier</button>${roleLinks}</div>
    <div id="wz-rlout"></div>
    <p class="note">When goods arrive, make the delivery link for the signers: <button class="linkbtn" type="button" id="wz-dlink">Make the delivery link for ${esc(p.po)}</button>. Pool top-up and the agent's key are separate approvals under <button class="linkbtn" type="button" id="wz-adv">Advanced</button>.</p>
    <div class="row"><button class="btn ghost" type="button" id="wz-new">Start a new order</button></div>`;
  $("wz-po-dl2").onclick = () => printPO(p, d);
  $("wz-rsup").onclick = () => showLink($("wz-rlout"), rolePageLink("supplier", null, p.po), "Copy the supplier's link", MSG.order(p.po, p.sup.id), `Purchase order ${p.po}`); // opens their page with this order loaded, ready to invoice
  b.querySelectorAll("[data-rl]").forEach((x) => (x.onclick = () => showLink($("wz-rlout"), rolePageLink("signer", x.dataset.rl), `Copy the ${x.dataset.rl}'s link`, MSG.rolePage(x.dataset.rl), `Your Clear to Pay page: ${x.dataset.rl}`)));
  $("wz-dlink").onclick = () => K.openAdvanced("link", { order: p.po, lines: p.lines, roles: p.roles });
  $("wz-adv").onclick = () => K.openAdvanced("pool");
  remember(d); // orders signed before this list existed join it when opened
  $("wz-new").onclick = () => { D = blank(); save(); paint(); }; // this order stays on chain and under "Your recent orders"
  readBack(p);
}
async function readBack(p) {
  const c = K.contract();
  try {
    const [o, pol, sg, lim] = await Promise.all([view(c, "get_order", { order_id: p.po }), view(c, "get_delivery_policy", { order_id: p.po }), view(c, "get_delivery_signers"), view(c, "get_limits")]);
    const okLines = o && o.lines.length === p.lines.length && o.lines.every((l, i) => l.sku === p.lines[i].sku && String(l.qty) === p.lines[i].qty && String(l.unit_price) === p.lines[i].unit_price);
    const okSup = o && o.supplier_id === p.sup.id, okPol = pol.required === 2 && JSON.stringify(pol.roles) === JSON.stringify(p.roles);
    const okSig = p.added.every((a) => sg.some((s) => s.key === a.key && s.role === a.role));
    const okLim = !p.limits.changed || (String(lim.per_invoice) === p.limits.inv && String(lim.per_supplier_per_period) === p.limits.per && String(lim.period_hours) === String(p.limits.hours) && +lim.max_submissions_per_day === +p.limits.max);
    const okRoles = p.roles.every((r) => sg.some((s) => s.role === r)); // CTP8-03: every required role has a signer now
    const all = okLines && okSup && okPol && okSig && okLim && okRoles;
    $("wz-back").innerHTML = `${all ? "<b>Read back from the contract: every part matches.</b>" : (okRoles ? "<b>Read back from the contract: something differs.</b> Check the transaction." : "<b>Read back: a required role has no registered signer now</b>, so deliveries cannot be confirmed until you add one (Advanced).")}
      <br>Order ${esc(p.po)}: ${okLines && okSup ? `${o.lines.length} lines for ${esc(o.supplier_id)}` : "not as signed"} · delivery policy v${esc(String(pol.version))}: 2 of ${esc(pol.roles.join(", "))} · ${p.added.length} new signer${p.added.length === 1 ? "" : "s"} ${okSig ? "registered" : "missing"}${p.limits.changed ? ` · limits ${okLim ? "set" : "not as signed"}` : ""}`;
  } catch { $("wz-back").textContent = "Could not read it back right now; the NearBlocks link shows the result."; }
}

// ---------------------------------------------------------------- sign once
async function signOnce(p) {
  const S = K.S;
  if (!S.wallet || S.me !== S.owner) return;
  // CTP8-02/03: read the contract again and rebuild the plan; if anything differs, show Review again instead of signing.
  try { await snapshot(); const q = plan(D, X, K.contract()); if (JSON.stringify(q.actions) !== JSON.stringify(p.actions)) throw new Error("changed"); }
  catch (e) { paint(); $("wz-msg").innerHTML = `<p class="err">${e.message === "changed" ? "The contract changed since you opened Review (limits, signers or the supplier). Check Review again, then sign." : esc(e.message || "Could not read the contract; nothing was signed.")}</p>`; return; }
  if (!confirm(`You are about to authorise ${p.po} for ${usdUnits(p.total)} to ${p.sup.id}, paid only to ${p.sup.addr}.\n\nOne transaction, ${p.actions.length} actions, on ${K.contract()}. All of it lands, or none of it does.`)) return;
  const out = $("wz-msg");
  try {
    D.signing = { plan: p, at: Date.now() }; save();
    sessionStorage.setItem("ctp-setup-pending", JSON.stringify({ id: "wizard", c: K.net() }));
    out.innerHTML = `<p class="muted">Waiting for your wallet…</p>`;
    const res = await S.wallet.signAndSendTransaction({ receiverId: K.contract(), actions: walletActions(p) });
    sessionStorage.removeItem("ctp-setup-pending");
    if (res) await finished(res.transaction?.hash || res.transaction_outcome?.id, res.status?.Failure || null, !res.status);
  } catch (e) { sessionStorage.removeItem("ctp-setup-pending"); out.innerHTML = `<p class="err">${esc(e.message || String(e))}</p>`; }
}
async function finished(hash, failure, unknown = false) {
  if (unknown && D.signing) {
    // CTP8-04: a hash is not a result. Keep the plan and say plainly that we could not read the outcome yet.
    save(); paint();
    $("wz-msg").innerHTML = `<p class="err"><b>Signed, but the result could not be read yet.</b> This page will not call it authorised until it reads a success from NEAR.</p><div class="row">${hash ? `<a class="btn ghost" href="${TX(hash)}" target="_blank" rel="noopener">See it on NearBlocks</a><button class="btn" type="button" id="wz-recheck">Check again</button>` : ""}</div>`;
    const b = $("wz-recheck"); if (b) b.onclick = async () => { b.disabled = true; const r = await K.txOutcome(hash); finished(hash, r.failure, r.state === "unknown"); };
    return;
  }
  const s = D.signing; D.signing = null;
  if (failure || !s) { save(); paint(); $("wz-msg").innerHTML = `<p class="err">Nothing was changed: the contract refused the transaction${failure ? ": " + esc(JSON.stringify(failure).slice(0, 260)) : ""}.</p>${hash ? `<a class="btn ghost" href="${TX(hash)}" target="_blank" rel="noopener">The transaction on NearBlocks</a>` : ""}`; return; }
  D.done = { hash, at: Date.now(), contract: K.contract(), buyer: K.S.me || K.S.owner, plan: s.plan }; D.step = 5; save(); remember(D.done);
  await snapshot().catch(() => {});
  const cs = X && X.suppliers.find((x) => x.id === s.plan.sup.id); if (cs) { D.done.chainFrom = cs.from; save(); remember(D.done); } // CTP8-07: the chain's time, not this browser's
  paint(); K.refresh();
}
/** Back from a redirect wallet (MyNearWallet): the page reloads with ?transactionHashes=… */
export async function returned(hash, failure, errorCode, unknown = false) {
  if (errorCode) { D.signing = null; save(); paint(); $("wz-msg").innerHTML = `<p class="err">The wallet did not sign (${esc(errorCode)}). Nothing was changed.</p>`; return; }
  await finished(hash, failure, unknown);
  $("wiz").scrollIntoView({ block: "start" });
}

// ---------------------------------------------------------------- the purchase order, printable (Save as PDF)
function printPO(p, done) {
  const po = $("po"), when = done ? new Date(done.at) : new Date();
  po.innerHTML = `<div class="wm ${done ? "ok" : ""}">${done ? "AUTHORISED ON NEAR TESTNET" : "DRAFT · NOT AUTHORISED"}</div>
    <header class="po-h"><div><b class="po-brand">Clear to Pay</b><span>Purchase order</span></div><div class="po-no"><b>${esc(p.po)}</b><span>${esc(when.toLocaleDateString([], { day: "2-digit", month: "long", year: "numeric" }))}</span></div></header>
    <div class="po-cols"><div><h5>Buyer</h5><p>${esc(done ? done.buyer : K.S.owner || "")}</p><h5>Contract</h5><p>${esc(p.contract)}</p></div>
      <div><h5>Supplier</h5><p>${esc(p.sup.id)}</p><h5>Paid only to</h5><p><b>${esc(p.sup.addr)}</b>${p.sup.proofResult?.state === "ok" ? "<br>address proved by the account itself (NEP-413)" : ""}<br>payable from ${esc(p.sup.isNew ? (done ? (done.chainFrom ? whenText(done.chainFrom) + " (read from the contract)" : whenText(done.at + H72) + " (estimated; not read back yet)") : "72 hours after signing") : whenText(p.sup.from))}</p></div></div>
    <table class="po-t"><thead><tr><th>Item</th><th>Quantity</th><th>Unit price (USDC)</th><th>Line total (USDC)</th></tr></thead>
      <tbody>${p.lines.map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.qty)}</td><td>${esc(fromUnits(l.unit_price))}</td><td>${esc(fromUnits((BigInt(l.qty) * BigInt(l.unit_price)).toString()))}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="3">Total</td><td>${esc(fromUnits(p.total))}</td></tr></tfoot></table>
    <div class="po-cols"><div><h5>Delivery</h5><p>Paid only for goods signed as delivered by 2 different roles of: ${esc(p.roles.join(", "))}.</p></div>
      <div><h5>Limits</h5><p>${esc(usdUnits(p.limits.inv))} per invoice; ${esc(usdUnits(p.limits.per))} per supplier every ${esc(p.limits.hours)} h.</p></div></div>
    <footer class="po-f">${done ? `Authorised on NEAR testnet ${esc(new Date(done.at).toISOString().replace("T", " ").slice(0, 16))} UTC · transaction <b>${esc(done.hash)}</b> · check it at testnet.nearblocks.io` : "Draft. Not authorised: nothing has been signed. An authorised order carries its NEAR transaction hash here."}<br>Invoices against this order are paid by the contract only to the registered address, at these prices, once. Testnet: not a real order.</footer>`;
  document.title = `${p.po} ${done ? "authorised" : "draft"}`;
  setTimeout(() => { window.print(); document.title = "Clear to Pay Buyer Setup"; }, 50);
}

// ---------------------------------------------------------------- paint and start
let msgTimer;
/** Bring the box a refusal is about into view and put the cursor in it. */
function focusField(f, text) {
  if (!f) { $("wz-msg").scrollIntoView({ block: "center", behavior: "smooth" }); return; }
  const el = f.startsWith("[") ? $("wz-body").querySelector(f) : $(f);
  if (!el) { $("wz-msg").scrollIntoView({ block: "center", behavior: "smooth" }); return; }
  el.scrollIntoView({ block: "center", behavior: "smooth" }); el.focus?.({ preventScroll: true });
  $("wz-body").querySelectorAll(".fixnote").forEach((n) => n.remove());
  const host = el.closest("label") || el.closest(".lrow3") || el;
  if (text) host.insertAdjacentHTML("afterend", `<p class="fixnote" role="alert">${esc(text)}</p>`);
  const note = host.nextElementSibling;
  el.classList.add("needfix");
  el.addEventListener(el.type === "checkbox" ? "change" : "input", () => { el.classList.remove("needfix"); if (note?.classList.contains("fixnote")) note.remove(); }, { once: true });
}
function msg(t, bad) { const m = $("wz-msg"); m.innerHTML = `<p class="${bad ? "err" : "okline"}">${esc(t)}</p>`; clearTimeout(msgTimer); if (!bad) msgTimer = setTimeout(() => (m.innerHTML = ""), 6000); }
function paint() {
  if (!X) return;
  stepper(); paintRecent();
  const b = $("wz-body"); $("wz-msg").innerHTML = "";
  if (D.done) { $("wz-title").textContent = "Order authorised"; paintDone(b); $("wz-nav").hidden = true; return; }
  $("wz-title").textContent = STEPS[D.step - 1];
  [paintSupplier, paintLines, paintSigners, paintLimits, paintReview][D.step - 1](b);
  $("wz-nav").hidden = D.step === 5;
  $("wz-prev").hidden = D.step === 1;
  $("wz-next").textContent = D.back ? "Back to review" : D.step === 4 ? "Review" : "Next";
}
async function next() {
  try {
    plan(D, X, K.contract());
  } catch (e) { if (e.step <= D.step) { msg(e.message, true); focusField(e.field, e.message); return; } }
  if (D.step === 2) { // an order number must be new
    try { if (await view(K.contract(), "get_order", { order_id: D.po.id.trim() })) { msg(`${D.po.id.trim()} already exists on ${K.contract()}: choose another order number.`, true); return; } } catch {}
  }
  const to = D.back ? 5 : D.step + 1; D.back = false; go(to);
}
export async function init(ctx) {
  K = ctx; D = load();
  document.addEventListener("ctp-who", () => { if (X && !D.done && D.step === 5) paint(); }); // wallet connected: the Review step's Sign once
  $("wz-prev").onclick = () => { D.back = false; go(Math.max(1, D.step - 1)); };
  $("wz-next").onclick = next;
  $("wz-reset").onclick = () => { if (confirm("Start over? The draft in this browser is cleared.")) { D = blank(); save(); paint(); } };
  await reload();
}
export async function reload() {
  D = load(); X = null; paintRecent(); $("wz-body").innerHTML = `<p class="muted">Reading ${esc(K.contract())}…</p>`;
  try { await snapshot(); paint(); } catch { $("wz-body").innerHTML = `<p class="err">Could not read the contract. Try again in a moment.</p>`; }
}
/** An invitation reply opened as a link (setup/#a=…): it fills the wizard; it never signs anything. */
export function fromReply(a) {
  if (a.kind === "supplier" && isSupplierId(a.supplier_id) && isAccount(a.address)) {
    D.sup = { mode: "new", id: a.supplier_id, key: a.key, addr: a.address, calledFor: "", proof: a.proof || null }; D.done = null; D.step = 1; D.max = Math.max(D.max, 1);
  } else if (a.kind === "signer") {
    if (!D.sig.add.some((s) => s.key === a.key) && !X?.signers.some((s) => s.key === a.key)) D.sig.add.push({ key: a.key, role: isRole(a.role) ? a.role : "" });
    D.done = null; D.step = 3; D.max = Math.max(D.max, 3);
  } else return;
  save(); paint();
  msg(a.kind === "supplier" ? `From an invitation: ${a.supplier_id} asks to be paid to ${a.address}. A link can be faked: call the supplier on a number you already had before you tick the box.` : "From an invitation: a delivery signer's key. Register it only if you sent that person the invitation.");
  $("wiz").scrollIntoView({ block: "start" });
}
