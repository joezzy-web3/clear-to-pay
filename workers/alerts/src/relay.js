// The signature relay. A signer's (or supplier's) page drops its send-back link here after signing;
// the buyer's Inbox picks it up, so nobody has to carry links back by hand.
// What it holds is public by design (signatures meant for the chain, and the note or invoice they sign).
// The Inbox checks every item against the chain before keeping it, so the relay decides nothing, and a
// junk or forged item is simply dropped there. Items expire after 30 days.
const MAX_BYTES = 12000, TTL = 60 * 60 * 24 * 30, LIST = 200;
const LINK = /^(n|i)=[A-Za-z0-9_-]{8,11000}&s=[A-Za-z0-9%_-]{40,200}&k=ed25519%3A[1-9A-HJ-NP-Za-km-z]{43,44}$/;
// A delivery signer's or supplier's details asking to be registered (a=…): a public key, a role or a payout account. Unsigned by nature.
const REQ = /^a=[A-Za-z0-9_-]{20,6000}$/;
// A company's own contract may use the relay too, under its own account name, once NEAR shows it is a real Clear to Pay contract:
// the pinned guard code (base58 of the sha-256 in docs/console/create.js; test/relay.test.mjs checks they match) and no access keys.
export const GUARD_CODE_B58 = "BUPx787xeoyTt73KmLNRfN5CQRzhfpZsgKT26HmmqWoJ";
const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
async function isGuard(env, account, query) {
  const ck = `guard:${account}`, c = await env.STATE.get(ck);
  if (c) return c === "1";
  let ok = false;
  try {
    const [acct, keys] = await Promise.all([query("view_account", account), query("view_access_key_list", account)]);
    ok = !!acct && acct.code_hash === GUARD_CODE_B58 && !!keys && Array.isArray(keys.keys) && keys.keys.length === 0;
  } catch { return false; } // NEAR did not answer: refuse now, ask again next time
  await env.STATE.put(ck, ok ? "1" : "0", { expirationTtl: ok ? 86400 : 600 });
  return ok;
}
export const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

// The ids of a net live in one index key, so an Inbox poll is one KV read. Listing keys instead would spend
// the free tier's 1,000 list operations a day within hours, with a few Inboxes open (one poll every 15 seconds).
const IDX = (net) => `relayidx:${net}`;
const fresh = (a, now) => (Array.isArray(a) ? a : []).filter((e) => e && /^[0-9a-f]{32}$/.test(e.id) && e.exp > now);
async function readIndex(env, net, prefix) {
  const raw = await env.STATE.get(IDX(net)), now = Date.now();
  if (raw !== null) { try { return fresh(JSON.parse(raw), now).map((e) => e.id); } catch { return []; } }
  // first read after this change: build the index once from the stored items, then never list again
  let ids = [];
  try { ids = (await env.STATE.list({ prefix, limit: LIST })).keys.map((k) => k.name.slice(prefix.length)); } catch { return []; } // list refused: try again next poll
  await env.STATE.put(IDX(net), JSON.stringify(ids.map((id) => ({ id, exp: now + TTL * 1000 }))), { expirationTtl: TTL });
  return ids;
}
async function addToIndex(env, net, id) {
  // two posts at the same moment can overwrite each other's index write: read back, and write once more if ours is missing
  for (let i = 0; i < 2; i++) {
    let a = []; try { a = JSON.parse((await env.STATE.get(IDX(net))) || "[]"); } catch {}
    const now = Date.now(), list = fresh(a, now).filter((e) => e.id !== id);
    list.unshift({ id, exp: now + TTL * 1000 });
    await env.STATE.put(IDX(net), JSON.stringify(list.slice(0, LIST)), { expirationTtl: TTL });
    try { if (fresh(JSON.parse((await env.STATE.get(IDX(net))) || "[]"), Date.now()).some((e) => e.id === id)) return; } catch {}
  }
}

/** POST /relay?net=live  body: the send-back link's hash (n=…&s=…&k=…)  → { id }
 *  GET  /relay?net=live            → { ids: [...] }   (newest first is not promised; the Inbox remembers what it has)
 *  GET  /relay?net=live&id=<id>    → the stored link, as text */
export async function relay(req, env, url, ctx, hooks = {}) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const named = Object.fromEntries(String(env.CONTRACTS || "").split(",").map((x) => x.trim().split("=")).filter((x) => x.length === 2));
  const net = url.searchParams.get("net") || "";
  const contract = named[net] || (ACCOUNT.test(net) && !Object.values(named).includes(net) && hooks.query && (await isGuard(env, net, hooks.query)) ? net : null);
  if (!contract) return json({ error: "unknown net" }, 400);
  const prefix = `relay:${net}:`;
  if (req.method === "POST") {
    const body = (await req.text()).trim();
    if (body.length > MAX_BYTES || !(LINK.test(body) || REQ.test(body))) return json({ error: "not a send-back link" }, 400);
    const id = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).slice(0, 32);
    if (!(await env.STATE.get(prefix + id))) {
      await env.STATE.put(prefix + id, body, { expirationTtl: TTL });
      await addToIndex(env, net, id);
      if (hooks.onNew) { const job = hooks.onNew(net, contract, body).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job; }
    }
    return json({ id });
  }
  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    if (id) {
      if (!/^[0-9a-f]{32}$/.test(id)) return json({ error: "bad id" }, 400);
      const v = await env.STATE.get(prefix + id);
      return v ? new Response(v, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", ...CORS } }) : json({ error: "gone" }, 404);
    }
    return json({ ids: await readIndex(env, net, prefix) });
  }
  return json({ error: "method" }, 405);
}
