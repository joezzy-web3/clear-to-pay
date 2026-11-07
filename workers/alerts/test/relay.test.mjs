// The signature relay: only send-back links, per contract, deduplicated, and readable from any origin.
import assert from "node:assert/strict";
import worker from "../src/index.js";
const kv = new Map();
const env = { CONTRACTS: "live=guard.cleartopay.testnet,demo=judge.cleartopay.testnet", STATE: {
  get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v),
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) } };
const call = (method, q, body) => worker.fetch(new Request("https://w.example/relay" + q, { method, body }), env);
const link = "n=eyJjb250cmFjdCI6Imd1YXJkLmNsZWFydG9wYXkudGVzdG5ldCJ9&s=" + encodeURIComponent("a".repeat(86) + "==") + "&k=" + encodeURIComponent("ed25519:9ZCa14SNQWtRoJA7CpsTmVVStenXCwt4BbQigDr5w9rf");

let r = await call("POST", "?net=live", link); assert.equal(r.status, 200); const { id } = await r.json(); assert.match(id, /^[0-9a-f]{32}$/);
assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
await call("POST", "?net=live", link); assert.equal(kv.size, 1, "the same link twice is kept once");
assert.deepEqual((await (await call("GET", "?net=live")).json()).ids, [id]);
assert.equal(await (await call("GET", "?net=live&id=" + id)).text(), link);
assert.deepEqual((await (await call("GET", "?net=demo")).json()).ids, [], "contracts are kept apart");
assert.equal((await call("POST", "?net=mainnet", link)).status, 400, "only the watched contracts");
for (const bad of ["hello", link.replace("&k=", "&x="), "n=abc&s=x&k=ed25519%3Ashort", link + "<script>", "x".repeat(13000)])
  assert.equal((await call("POST", "?net=live", bad)).status, 400, "refused: " + bad.slice(0, 30));
assert.equal((await call("GET", "?net=live&id=../../subs")).status, 400);
assert.equal((await call("OPTIONS", "?net=live")).status, 204);
console.log("ok  relay: send-back links only, per contract, kept once, CORS for the Console");
