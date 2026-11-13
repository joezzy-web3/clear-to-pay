// Clear to Pay alerts on Cloudflare Workers: no PC has to stay on.
// - Every minute (cron) it reads one watched contract, compares with what it saw last time
//   (KV), and sends each change to the Telegram chats subscribed for it.
// - Telegram calls /telegram when someone taps Start on a "Get alerts" link from the Console.
// Secrets: TELEGRAM_BOT_TOKEN only (wrangler secret put). The webhook's secret is derived
// from it, so there is nothing else to keep in sync. No NEAR keys: public views only.
import { relay } from "./relay.js";
import { notice } from "./notify.js";
import { snapshot, changes, format, parseStart, recipients } from "./core.js";

const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const MAX_SUBS = 300;
const enc = new TextEncoder();

const nets = (env) => Object.fromEntries(String(env.CONTRACTS || "").split(",").map((x) => x.trim().split("=")).filter((x) => x.length === 2));

async function call(rpc, contract, method, args) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "ctp", method: "query", params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) } });
  const r = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(10000) }); // a slow server must not stretch a tick into the next one
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(j.result.result)));
}
const viewer = (contract) => async (m, a) => { try { return await call(RPCS[0], contract, m, a); } catch { return await call(RPCS[1], contract, m, a); } };

async function webhookSecret(env) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode("ctp-webhook:" + env.TELEGRAM_BOT_TOKEN));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
async function tg(env, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
  return r.json().catch(() => ({ ok: false })); // never log the URL: it holds the token
}
const say = (env, chat, text) => tg(env, "sendMessage", { chat_id: chat, text, disable_web_page_preview: true });

// ---------------------------------------------------------------- one tick
async function tick(env, key, contract) {
  const view = viewer(contract);
  const stateKey = `state:${key}`, raw = await env.STATE.get(stateKey);
  let old = null, damaged = false;
  if (raw) { try { old = JSON.parse(raw); } catch { damaged = true; } }
  const now = await snapshot(view, USDC, old);
  const alerts = [];
  if (damaged) alerts.push({ level: "ALARM", text: "The alert watcher's memory was damaged and has been rebuilt. Changes made meanwhile may not have been announced: check the ledger now.", to: ["buyer"] });
  // a second RPC server must agree about the two things an attacker would most like to hide
  try {
    const other = (m, a) => call(RPCS[1], contract, m, a);
    for (const s of Object.keys(now.suppliers)) {
      const x = await other("get_supplier", { supplier_id: s });
      if (x && x.route_on_file.address !== now.suppliers[s].route) alerts.push({ level: "ALARM", text: `RPC servers disagree about supplier ${s}'s payout address record. Check it on NearBlocks before approving or paying anything.`, to: ["buyer", "supplier:" + s] });
    }
    const ks = ((await other("get_delivery_signers", {})) || []).map((x) => x.key).sort().join(",");
    if (ks !== Object.keys(now.signers).sort().join(",")) alerts.push({ level: "ALARM", text: "RPC servers disagree about the delivery signers. Check them on NearBlocks.", to: ["buyer", "signers"] });
  } catch { /* the second server is down: not an alarm on its own */ }
  if (old) alerts.push(...changes(old, now));
  const subs = JSON.parse((await env.STATE.get(`subs:${key}`)) || "{}");
  // remember first, then speak: if a tick is slow and the next one starts, it already sees this state and does not repeat the alerts
  const next = JSON.stringify(now);
  if (next !== raw) await env.STATE.put(stateKey, next); // write only on change (KV write budget)
  for (const a of alerts) for (const chat of recipients(a, subs)) await say(env, chat, format(a, contract));
  return alerts.length;
}

// ---------------------------------------------------------------- relay notices
/** A plain account query (view_account, view_access_key_list); both servers must agree, as the Console requires. */
async function rawQuery(request_type, account_id) {
  const one = async (rpc) => {
    const r = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "ctp", method: "query", params: { request_type, finality: "final", account_id } }), signal: AbortSignal.timeout(10000) });
    const j = await r.json(); if (j.error) throw new Error("rpc"); return j.result;
  };
  const [a, b] = await Promise.all(RPCS.map(one));
  if (JSON.stringify(request_type === "view_account" ? a.code_hash : a.keys.length) !== JSON.stringify(request_type === "view_account" ? b.code_hash : b.keys.length)) throw new Error("servers disagree");
  return a;
}
/** Tell the buyer's chats (only ours have subscribers) what a new relay item means. */
async function onRelayed(env, net, contract, body) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const subs = JSON.parse((await env.STATE.get(`subs:${net}`)) || "{}");
  const chats = recipients({ to: ["buyer"] }, subs); if (!chats.length) return;
  const view = viewer(contract);
  const text = await notice(body, contract, view, env.STATE, net);
  if (text) for (const chat of chats) await say(env, chat, text);
}

// ---------------------------------------------------------------- Telegram
const ROLE_NAME = (r) => r === "buyer" ? "the buyer" : r === "signers" ? "the delivery signers" : "supplier " + r.slice(9);
async function onUpdate(env, u) {
  const m = u.message; if (!m || !m.chat || typeof m.text !== "string") return;
  const chat = String(m.chat.id), text = m.text.trim(), N = nets(env);
  const [cmd, arg] = text.split(/\s+/, 2);
  if (cmd === "/start" && arg) {
    const s = parseStart(arg, N);
    if (!s) return say(env, chat, "That link is not a Clear to Pay alert link. Open it again from the Console.");
    const key = `subs:${s.net}`, subs = JSON.parse((await env.STATE.get(key)) || "{}");
    if (!subs[chat] && Object.keys(subs).length >= MAX_SUBS) return say(env, chat, "This contract has too many subscribers. Ask the buyer.");
    const roles = new Set(subs[chat]?.roles || []); roles.add(s.role);
    subs[chat] = { roles: [...roles], since: subs[chat]?.since || Date.now() };
    await env.STATE.put(key, JSON.stringify(subs));
    return say(env, chat, `Subscribed: alerts for ${ROLE_NAME(s.role)} on ${N[s.net]}.\nYou will hear about payout address changes (during their 72-hour wait), new delivery signers, every verdict and every payment. Everything here is public on NEAR; no keys or invoices are sent.\n/status to see your alerts, /stop to end them.`);
  }
  if (cmd === "/stop") {
    let n = 0;
    for (const net of Object.keys(N)) {
      const key = `subs:${net}`, subs = JSON.parse((await env.STATE.get(key)) || "{}");
      if (subs[chat]) { delete subs[chat]; n++; await env.STATE.put(key, JSON.stringify(subs)); }
    }
    return say(env, chat, n ? "Alerts stopped. Tap a Get alerts link in the Console to start again." : "You had no alerts.");
  }
  if (cmd === "/status" || cmd === "/start") {
    const lines = [];
    for (const [net, c] of Object.entries(N)) {
      const subs = JSON.parse((await env.STATE.get(`subs:${net}`)) || "{}");
      if (subs[chat]) lines.push(`${c}: ${subs[chat].roles.map(ROLE_NAME).join(", ")}`);
    }
    return say(env, chat, lines.length ? "Your alerts:\n" + lines.join("\n") : "No alerts yet. Open Clear to Pay's Buyer setup or Sign page and tap Get alerts on Telegram.\nhttps://clear-to-pay.vercel.app/console/setup/");
  }
}

export default {
  async scheduled(event, env) {
    const list = Object.entries(nets(env)); if (!list.length || !env.TELEGRAM_BOT_TOKEN) return;
    const [key, contract] = list[Math.floor(Date.now() / 60000) % list.length]; // one contract a minute keeps us inside the subrequest budget
    await tick(env, key, contract);
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/relay") return relay(req, env, url, ctx, { query: rawQuery, onNew: (net, contract, body) => onRelayed(env, net, contract, body) }); // signatures and details carried from phones to the buyer's Inbox
    if (req.method === "POST" && url.pathname === "/telegram") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await webhookSecret(env))) return new Response("forbidden", { status: 403 });
      try { await onUpdate(env, await req.json()); } catch {}
      return new Response("ok");
    }
    if (url.pathname === "/register") { // points the bot's webhook at this worker; harmless to repeat
      const r = await tg(env, "setWebhook", { url: `${url.origin}/telegram`, secret_token: await webhookSecret(env), allowed_updates: ["message"] });
      return new Response(r.ok ? "Webhook set. Tap a Get alerts link to subscribe." : "Telegram refused: " + (r.description || "unknown"), { status: r.ok ? 200 : 502 });
    }
    return new Response("Clear to Pay alerts: running.");
  },
};
