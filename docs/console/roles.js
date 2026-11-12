// Clear to Pay Console: whose page this is (the role banner) and a short, skippable guide per role.
const ROLES = {
  judge: { name: "JUDGE MODE", line: "Try to fool it: real testnet transactions, no wallet, no install." },
  buyer: { name: "BUYER PAGE", line: "Orders, limits and payments. Only the buyer's wallet can sign here." },
  supplier: { name: "SUPPLIER PAGE", line: "Your payout address, your invoices and payments. No wallet needed." },
  signer: { name: "DELIVERY SIGNER PAGE", line: "Confirm what arrived. Your signing key stays on this phone." },
  overview: { name: "BUYER PAGE", line: "What the agent can spend, read live. Nothing here can be signed.", color: "buyer" },
  create: { name: "NEW CONTRACT", line: "Your company's own Clear to Pay contract, in two wallet approvals.", color: "buyer" },
  pick: { name: "SIGN PAGE", line: "For delivery signers and suppliers. Choose who you are below." },
};
const GUIDES = {
  create: [
    ["Connect the wallet that will own it", "That account becomes the contract's owner and pays 3.6 NEAR, which stays on the contract as its storage. Tip: after it is created, the page shows whether a backup key protects this account, so a lost recovery phrase never locks you out."],
    ["Choose a name", "Your contract becomes <i>name</i>.factory.cleartopay.testnet. The page tells you as you type whether it is free."],
    ["Approve once: create", "One ordinary call to our factory. It creates the contract, installs exactly our Live guard's code and makes you its owner, with no keys: nobody, us included, can change it. If anything fails, your 3.6 NEAR comes back."],
    ["The page checks it on NEAR", "Two NEAR servers must agree: our exact code, no keys, you as the owner. Only then does it say ready."],
    ["Approve again, then set it up", "Register it with testnet USDC (0.00125 NEAR) so it can hold your pool. Then open Buyer setup: it already knows your contract."],
  ],
  buyer: [
    ["Invite the supplier", "In New order, step 1 makes an invitation link. The supplier opens it on their phone and sends you a reply."],
    ["Call them and check the address", "On a phone number you already had, never one from an email or invoice. They read their payout address back to you."],
    ["Fill the order", "Items, who confirms delivery (two different roles), limits. Nothing opens your wallet while you fill it; the draft saves itself."],
    ["Review, then sign once", "One approval sends everything in one transaction. All of it lands, or none of it does."],
    ["Send the delivery links", "When goods arrive, send the storekeeper and the weighbridge their links. Invoices then clear only for what they signed."],
  ],
  supplier: [
    ["Make your key on this phone", "The private part never leaves this phone. Nobody, including the buyer, will ever ask you for it."],
    ["Send the reply to the buyer", "It carries only your public key and the account you want to be paid to."],
    ["Wait for their call", "The buyer calls you on a number they already had and reads your payout address back. Check every character."],
    ["When you invoice, sign it here", "Open the invoice link the buyer's system sends you, check the payee and total, and tap Sign invoice."],
    ["Watch your status", "This page shows your payout address, any change waiting, and every invoice and payment, read from the chain."],
  ],
  signer: [
    ["This phone made you a signing key", "The private part never leaves this phone. Nobody, including the buyer, will ever ask you for it."],
    ["Tap Send to buyer, once", "It sends only the public part, so the buyer can add you as the storekeeper (or weighbridge)."],
    ["When goods arrive, sign the link", "The buyer sends you a delivery link. Open it on this phone, check the note against what you received, tap Sign delivery, then Send back."],
    ["New phone or cleared browser?", "Make a new key here and send it again; the buyer removes the old one."],
  ],
};
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

const OTHER = { signer: "Delivery signer", supplier: "Supplier" };
let page = null, listening = false;
/** Paint the banner at the top of the page for `role` (judge | buyer | supplier | signer | pick).
 *  On a buyer page, a visitor who picked Delivery signer or Supplier is told whose page this is and sent to theirs. */
export function banner(role) {
  const el = document.getElementById("rband"); if (!el) return;
  page = role;
  if (role === "buyer" && !listening) { listening = true; addEventListener("ctp-role", () => banner(page)); }
  const me = role === "buyer" ? store.get("ctp-role") : null;
  if (me in OTHER) {
    el.dataset.r = me;
    el.innerHTML = `<div class="rband-in"><b>BUYER'S PAGE</b><span>This is the buyer's page. You picked ${OTHER[me]}.</span><a class="rband-go" href="${new URL("sign/", import.meta.url).href}">Go to the ${OTHER[me]} page →</a></div>`;
    return;
  }
  const r = ROLES[role] || ROLES.pick, g = GUIDES[role];
  el.dataset.r = role in ROLES ? (ROLES[role].color || role) : "pick";
  el.innerHTML = `<div class="rband-in"><b>${r.name}</b><span>${r.line}</span>${g ? `<button type="button" class="rband-g" id="rband-g">Show the guide</button>` : ""}</div>`;
  if (g) document.getElementById("rband-g").onclick = () => guide(role, true);
}

/** The guide for `role`: on the first visit, or when asked. Remembered per role in this browser. */
export function guide(role, force = false) {
  const steps = GUIDES[role]; if (!steps) return;
  const seen = "ctp-guide-seen:" + role;
  if (!force && store.get(seen)) return;
  document.getElementById("guide")?.remove();
  const box = document.createElement("div");
  box.id = "guide"; box.className = "guide"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-labelledby", "guide-h");
  let i = 0;
  const close = () => { store.set(seen, "1"); box.remove(); removeEventListener("keydown", onKey); opener?.focus?.(); };
  const opener = document.activeElement;
  const paint = () => {
    const [t, d] = steps[i];
    box.innerHTML = `<div class="guide-card">
      <div class="guide-top"><span>${ROLES[role].name} · ${i + 1} of ${steps.length}</span><button type="button" class="guide-skip">Skip</button></div>
      <ol class="guide-dots" aria-hidden="true">${steps.map((_, n) => `<li class="${n === i ? "on" : n < i ? "done" : ""}"></li>`).join("")}</ol>
      <b class="guide-n">${i + 1}</b><h2 id="guide-h">${t}</h2><p>${d}</p>
      <div class="guide-nav">${i ? `<button type="button" class="guide-back">Back</button>` : "<span></span>"}<button type="button" class="guide-next">${i === steps.length - 1 ? "Got it" : "Next"}</button></div></div>`;
    box.querySelector(".guide-skip").onclick = close;
    box.querySelector(".guide-next").onclick = () => (i === steps.length - 1 ? close() : (i++, paint()));
    const b = box.querySelector(".guide-back"); if (b) b.onclick = () => { i--; paint(); };
    box.querySelector(".guide-next").focus();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  addEventListener("keydown", onKey);
  box.addEventListener("click", (e) => { if (e.target === box) close(); });
  document.body.append(box); paint();
}
