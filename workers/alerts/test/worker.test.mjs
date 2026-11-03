// The worker end to end with a fake KV, a fake NEAR RPC and a fake Telegram.
import assert from "node:assert/strict";
import worker from "../src/index.js";
const kv = new Map(), sent = [];
const env = { CONTRACTS: "demo=judge.cleartopay.testnet", BOT_USERNAME: "CleartoPayAlertsBOT", TELEGRAM_BOT_TOKEN: "123:test",
  STATE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) } };
let chain = { get_supplier_ids: ["qingmar-steel"], receipt_count: 0, get_delivery_signers: [], get_funds: { available: "15000000", reserved: "0" },
  get_supplier: { route_on_file: { address: "qingmar.cleartopay.testnet" }, route_payable_from: "1", last_nonce: 0, pending: null } };
globalThis.fetch = async (url, init) => {
  const u = String(url), body = JSON.parse(init.body);
  if (u.includes("api.telegram.org")) { sent.push(body); return new Response(JSON.stringify({ ok: true })); }
  const m = body.params.method_name;
  return new Response(JSON.stringify({ result: { result: [...new TextEncoder().encode(JSON.stringify(chain[m]))] } }));
};
const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ctp-webhook:123:test"));
const secret = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
const post = (text, s = secret) => worker.fetch(new Request("https://w.example/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": s }, body: JSON.stringify({ message: { chat: { id: 42 }, text } }) }), env);

assert.equal((await post("/start demo_b", "wrong")).status, 403);          // only Telegram may call it
await post("/start demo_b");
assert.deepEqual(JSON.parse(kv.get("subs:demo"))["42"].roles, ["buyer"]);
assert.match(sent.at(-1).text, /Subscribed: alerts for the buyer/);
await worker.scheduled({}, env);                                         // first tick: remembers, sends nothing
const before = sent.length;
chain = { ...chain, get_delivery_signers: [{ key: "ed25519:NEW", role: "weighbridge" }] };
await worker.scheduled({}, env);
assert.equal(sent.length, before + 1); assert.match(sent.at(-1).text, /^ALERT \| judge\.cleartopay\.testnet\nDelivery signer ADDED/);
await worker.scheduled({}, env); assert.equal(sent.length, before + 1);   // no change, no message
await post("/stop"); assert.equal(JSON.parse(kv.get("subs:demo"))["42"], undefined);
console.log("ok  worker: webhook secret, subscribe, first tick silent, one alert per change, stop");
