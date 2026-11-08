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

// remember first, then speak: a second tick that starts while the first is still sending does not repeat the alert
{
  const kv2 = new Map(), sent2 = []; let release;
  const env2 = { ...env, STATE: { get: async (k) => kv2.get(k) ?? null, put: async (k, v) => void kv2.set(k, v) } };
  globalThis.fetch = async (url, init) => {
    const u = String(url), body = JSON.parse(init.body);
    if (u.includes("api.telegram.org")) { if (body.text && body.text.startsWith("ALERT")) { sent2.push(body); if (sent2.length === 1) await new Promise((r) => (release = r)); } return new Response(JSON.stringify({ ok: true })); }
    return new Response(JSON.stringify({ result: { result: [...new TextEncoder().encode(JSON.stringify(chain[body.params.method_name]))] } }));
  };
  kv2.set("subs:demo", JSON.stringify({ 42: { roles: ["buyer"] } }));
  await worker.scheduled({}, env2);                                        // first tick: remembers
  chain = { ...chain, get_delivery_signers: [...chain.get_delivery_signers, { key: "ed25519:TWO", role: "storekeeper" }] };
  const slow = worker.scheduled({}, env2);                                 // sends, and Telegram hangs
  await new Promise((r) => setTimeout(r, 20));
  await worker.scheduled({}, env2);                                        // the next tick starts meanwhile
  release(); await slow;
  assert.equal(sent2.length, 1, "one alert, not two");
  console.log("ok  worker: a slow tick and the next one do not send the same alert twice");
}
