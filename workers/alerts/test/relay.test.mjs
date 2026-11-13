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

// Details asking to be registered travel the same way; a company's own contract may use the relay once NEAR confirms it.
{
  const { GUARD_CODE_B58 } = await import("../src/relay.js");
  const create = await import("../../../docs/console/create.js");
  assert.equal(GUARD_CODE_B58, create.CODE_HASH_B58, "the relay's pin is the Console's pin");
  const req = "a=" + btoa(JSON.stringify({ contract: "judge.cleartopay.testnet", kind: "signer", key: "ed25519:9ZCa14SNQWtRoJA7CpsTmVVStenXCwt4BbQigDr5w9rf" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal((await call("POST", "?net=demo", req)).status, 200, "details are accepted");
  assert.equal((await call("POST", "?net=demo", "a=<script>")).status, 400);
  const real = new Map([["acme.factory.cleartopay.testnet", { code: GUARD_CODE_B58, keys: [] }], ["keyed.testnet", { code: GUARD_CODE_B58, keys: [{ public_key: "ed25519:x" }] }], ["evil.testnet", { code: "1111", keys: [] }]]);
  let asked = 0;
  globalThis.fetch = async (url, o) => { asked++; const { params } = JSON.parse(o.body), a = real.get(params.account_id);
    return { json: async () => (a ? { result: params.request_type === "view_account" ? { code_hash: a.code } : { keys: a.keys } } : { error: { message: "unknown" } }) }; };
  assert.equal((await call("POST", "?net=acme.factory.cleartopay.testnet", link)).status, 200, "a verified own contract");
  const n = asked; await call("GET", "?net=acme.factory.cleartopay.testnet"); assert.equal(asked, n, "the verdict is cached");
  assert.equal((await call("POST", "?net=keyed.testnet", link)).status, 400, "a contract with a key is refused");
  assert.equal((await call("POST", "?net=evil.testnet", link)).status, 400, "other code is refused");
  assert.equal((await call("POST", "?net=nobody.testnet", link)).status, 400, "an account NEAR does not know is refused");
  assert.equal((await call("POST", "?net=judge.cleartopay.testnet", link)).status, 400, "our contracts keep their short names");
  delete globalThis.fetch;
}
console.log("ok  relay: details requests, and own contracts only once NEAR confirms the pinned code and no keys");
