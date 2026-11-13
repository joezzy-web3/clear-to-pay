// Telegram notices for what arrives on the relay: who signed, and what is still needed before the buyer can submit.
// The relay is open, so nothing is announced on its word: a signature is announced only after the worker has checked it
// with the same digests the contract uses (docs/console/crypto.js, links.js) and found its key registered on chain for
// that role or supplier. A request to be registered is unsigned by nature; it is announced as a request, a few an hour.
import * as C from "../../../docs/console/crypto.js";
import { parseBack, parseRequest } from "../../../docs/console/links.js";

const INBOX = "https://clear-to-pay.vercel.app/console/inbox/";
const short = (k) => (k.length > 20 ? k.slice(0, 14) + "…" + k.slice(-6) : k);
const list = (xs) => (xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);
const REQ_PER_HOUR = 6, KEEP = 60 * 60 * 24 * 30;

/** What to tell the buyer about one new relay item, or null. view(method, args) reads the contract; kv is the worker's KV. */
export async function notice(body, contract, view, kv, net, now = Date.now()) {
  const p = new URLSearchParams(body);
  const got = parseBack(p, C);
  if (got) {
    if (got.bad || got.contract !== contract) return null;
    const key = `prog:${net}:${got.kind === "delivery" ? got.note.order_id : got.invoice.order_id}`;
    let prog; try { prog = JSON.parse((await kv.get(key)) || "{}"); } catch { prog = {}; }
    prog.notes ||= {}; prog.invoices ||= [];
    let head;
    if (got.kind === "delivery") {
      const signers = (await view("get_delivery_signers", {})) || [];
      if (!signers.some((s) => s.key === got.key && s.role === got.role)) return null; // not registered for that role: say nothing
      const policy = (await view("get_delivery_policy", { order_id: got.note.order_id })) || { required: 2, version: got.policy_version };
      if (policy.version !== got.policy_version) return null;
      const n = (prog.notes[got.note.note_id] ||= { roles: [] });
      if (!n.roles.includes(got.role)) n.roles.push(got.role);
      head = `Delivery signed: ${got.role} signed note ${got.note.note_id} for order ${got.note.order_id}.`;
      prog.required = policy.required; prog.allRoles = policy.roles && policy.roles.length ? policy.roles : [...new Set(signers.map((s) => s.role))];
    } else {
      const sup = await view("get_supplier", { supplier_id: got.invoice.supplier_id });
      if (!sup || sup.signing_key !== got.key) return null; // not the supplier's registered key: say nothing
      if (!prog.invoices.includes(got.invoice.invoice_number)) prog.invoices.push(got.invoice.invoice_number);
      head = `Invoice signed: supplier ${got.invoice.supplier_id} signed invoice ${got.invoice.invoice_number} for order ${got.invoice.order_id}.`;
      if (!prog.required) {
        let policy = null, signers = [];
        try { policy = await view("get_delivery_policy", { order_id: got.invoice.order_id }); signers = (await view("get_delivery_signers", {})) || []; } catch {}
        prog.required = policy ? policy.required : 2; prog.allRoles = policy && policy.roles && policy.roles.length ? policy.roles : [...new Set(signers.map((s) => s.role))];
      }
    }
    await kv.put(key, JSON.stringify(prog), { expirationTtl: KEEP });
    // What is left: the note with the most roles decides, then the invoice.
    const best = Object.entries(prog.notes).sort((a, b) => b[1].roles.length - a[1].roles.length)[0];
    const have = best ? best[1].roles : [], need = Math.max(0, (prog.required || 2) - have.length);
    const missing = (prog.allRoles || []).filter((r) => !have.includes(r));
    const left = [];
    if (need) left.push(`${need === 1 ? "one more delivery role" : need + " more delivery roles"}${missing.length ? " (" + list(missing) + ")" : ""}`);
    if (!prog.invoices.length) left.push("the supplier's signed invoice");
    const tail = left.length ? `Still needed: ${list(left)}.` : `Everything is in for order ${got.kind === "delivery" ? got.note.order_id : got.invoice.order_id}: every delivery role and the supplier's invoice. Open your Inbox to let the AI read the PDF and submit.`;
    return `${head}\nChecked: signature valid, key registered on ${contract}.\n${tail}\n${INBOX}`;
  }
  const req = parseRequest(p);
  if (!req || req.contract !== contract) return null;
  const rl = `rl:${net}:${Math.floor(now / 3600000)}`, n = Number((await kv.get(rl)) || 0);
  if (n >= REQ_PER_HOUR) return null;
  await kv.put(rl, String(n + 1), { expirationTtl: 7200 });
  return req.who === "signer"
    ? `Request to join: a delivery signer${req.role ? " (" + req.role + ")" : ""} with key ${short(req.key)} asks to be registered on ${contract}.\nNothing is on chain yet. Review it in your Inbox and register it with your wallet if you know them.\n${INBOX}`
    : `Request to join: supplier ${req.supplier_id} asks to be registered on ${contract}, to be paid at ${req.address}${req.proved ? " (they proved they control it)" : ""}.\nNothing is on chain yet. Call them to confirm the payout account, then register it from your Inbox.\n${INBOX}`;
}
