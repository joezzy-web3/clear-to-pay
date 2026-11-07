// The signature relay. A signer's (or supplier's) page drops its send-back link here after signing;
// the buyer's Inbox picks it up, so nobody has to carry links back by hand.
// What it holds is public by design (signatures meant for the chain, and the note or invoice they sign).
// The Inbox checks every item against the chain before keeping it, so the relay decides nothing, and a
// junk or forged item is simply dropped there. Items expire after 30 days.
const MAX_BYTES = 12000, TTL = 60 * 60 * 24 * 30, LIST = 200;
const LINK = /^(n|i)=[A-Za-z0-9_-]{8,11000}&s=[A-Za-z0-9%_-]{40,200}&k=ed25519%3A[1-9A-HJ-NP-Za-km-z]{43,44}$/;
export const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** POST /relay?net=live  body: the send-back link's hash (n=…&s=…&k=…)  → { id }
 *  GET  /relay?net=live            → { ids: [...] }   (newest first is not promised; the Inbox remembers what it has)
 *  GET  /relay?net=live&id=<id>    → the stored link, as text */
export async function relay(req, env, url) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const nets = String(env.CONTRACTS || "").split(",").map((x) => x.split("=")[0].trim()).filter(Boolean);
  const net = url.searchParams.get("net") || "";
  if (!nets.includes(net)) return json({ error: "unknown net" }, 400);
  const prefix = `relay:${net}:`;
  if (req.method === "POST") {
    const body = (await req.text()).trim();
    if (body.length > MAX_BYTES || !LINK.test(body)) return json({ error: "not a send-back link" }, 400);
    const id = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).slice(0, 32);
    if (!(await env.STATE.get(prefix + id))) await env.STATE.put(prefix + id, body, { expirationTtl: TTL });
    return json({ id });
  }
  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    if (id) {
      if (!/^[0-9a-f]{32}$/.test(id)) return json({ error: "bad id" }, 400);
      const v = await env.STATE.get(prefix + id);
      return v ? new Response(v, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", ...CORS } }) : json({ error: "gone" }, 404);
    }
    const l = await env.STATE.list({ prefix, limit: LIST });
    return json({ ids: l.keys.map((k) => k.name.slice(prefix.length)) });
  }
  return json({ error: "method" }, 405);
}
