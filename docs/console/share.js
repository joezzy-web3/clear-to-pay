// Clear to Pay: one way to hand a link to a person. A ready-written message (editable), the link,
// a QR code for someone standing next to you, and buttons for WhatsApp, email, the phone's share sheet
// and copy. Used for the supplier's order link, the signers' pages and every invitation.
import * as C from "./crypto.js";
import { esc, copy } from "./chain.js";

const CSS = `.sharebox{display:grid;gap:10px;margin-top:12px}
.sharebox .linkout{display:grid;grid-template-columns:minmax(0,1fr) 132px;gap:12px;align-items:start}
.sharebox .qr{background:#fff;border:1px solid var(--line,#D5DCD7);padding:6px}.sharebox .qr svg{display:block;width:100%;height:auto}
.sharebox label{display:grid;gap:6px;font:500 13px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase;color:var(--mute,#55657C)}
.sharebox textarea{font:400 15px/1.5 var(--body,sans-serif);letter-spacing:0;text-transform:none;color:var(--navy,#10264A);padding:10px 12px;border:1px solid var(--line,#D5DCD7);background:#fff;border-radius:0;width:100%;min-height:96px;resize:vertical}
.sharebox textarea:focus{outline:2px solid var(--signal,#E6BE4F);outline-offset:0}
.sharebox .shr{display:flex;gap:8px;flex-wrap:wrap}
.sharebox .shr .btn{display:inline-flex;align-items:center;gap:7px}
.sharebox .wa{background:#127A4A;color:#fff;box-shadow:none}
.sharebox .qrnote{font-size:13px;color:var(--mute,#55657C);margin:0}
.sharebox code.lk{display:block;background:var(--cell,#FAFBF9);border:1px solid var(--line,#D5DCD7);padding:10px;overflow-wrap:anywhere;font-size:12px}
@media (max-width:560px){.sharebox .linkout{grid-template-columns:1fr}.sharebox .qr{max-width:180px}}`;
let styled = false;
const style = () => { if (styled) return; styled = true; const s = document.createElement("style"); s.textContent = CSS; document.head.append(s); };

/** The message a person receives. It always ends with the link, so editing the words can't lose it. */
export function shareText(msg, link) { return `${String(msg || "").trim()}\n${link}`; }
export const waHref = (text) => "https://wa.me/?text=" + encodeURIComponent(text);
export const mailHref = (subject, text) => "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(text);

/** Fill `box` with the share controls for `link`. opts: { msg, subject, copyLabel } */
export function shareBox(box, link, { msg = "", subject = "Clear to Pay", copyLabel = "Copy the link" } = {}) {
  style();
  box.innerHTML = `<div class="sharebox">
    <label>The message<textarea rows="3" spellcheck="true">${esc(msg)}</textarea></label>
    <div class="shr">
      <a class="btn wa" target="_blank" rel="noopener" data-s="wa"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 0 0 1.9-1.3 2.3 2.3 0 0 0 .1-1.3c0-.1-.2-.2-.5-.3Z"/></svg>Send on WhatsApp</a>
      <a class="btn ghost" data-s="mail">Email</a>
      ${navigator.share ? `<button class="btn ghost" type="button" data-s="share">Share…</button>` : ""}
      <button class="btn ghost" type="button" data-s="msg">Copy the message</button>
      <button class="btn ghost" type="button" data-s="link">${esc(copyLabel)}</button>
    </div>
    <div class="linkout"><code class="lk">${esc(link)}</code><div class="qr" title="Scan with a phone camera">${C.qrSvg(link)}</div></div>
    <p class="qrnote">Next to them? They can scan the code with their phone camera instead.</p>
  </div>`;
  const ta = box.querySelector("textarea"), q = (k) => box.querySelector(`[data-s="${k}"]`);
  const text = () => shareText(ta.value, link);
  const refresh = () => { q("wa").href = waHref(text()); q("mail").href = mailHref(subject, text()); };
  ta.addEventListener("input", refresh); refresh();
  q("msg").onclick = (e) => copy(text(), e.currentTarget);
  q("link").onclick = (e) => copy(link, e.currentTarget);
  const sh = q("share"); if (sh) sh.onclick = async () => { try { await navigator.share({ title: subject, text: ta.value.trim(), url: link }); } catch {} };
  return box;
}

// ---- the messages, written once. Short, plain, and they say what happens next.
export const MSG = {
  order: (po, supplier) => `Hello${supplier ? " " + supplier : ""}, here is our purchase order ${po}. Open the link to see it and send your invoice from your phone: pick the quantities you delivered, sign, done. Nothing to install. We pay only to the payout address you registered with us.`,
  rolePage: (role) => `Hi, this is your Clear to Pay page as ${role}. Open it on your phone and keep it: when goods arrive, check what came in and sign. It takes a few seconds, and nothing gets paid without it.`,
  supplierPage: () => `Hello, this is your Clear to Pay supplier page. Open it on your phone to see our orders, send invoices and follow your payments.`,
  inviteSupplier: (id) => `Hello, we'd like to pay you through Clear to Pay (as "${id}"). Open the link on your phone: it makes your signing key (it never leaves your phone) and asks for your payout address. Then tap Send back and send me the reply. I'll call you to confirm the address before we register it.`,
  inviteSigner: (role) => `Hi, please set up your phone to confirm deliveries as ${role}. Open the link: it makes your signing key (it never leaves your phone). Then tap Send back and send me the reply, and I'll register you.`,
  delivery: (note, order, role) => `Please check delivery ${note} (order ${order}) against what arrived and sign it as ${role}. When you tap Sign, it reaches me by itself.`,
};
