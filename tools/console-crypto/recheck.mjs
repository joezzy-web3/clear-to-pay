// Re-check the AI reading that rode along with a Clear to Pay submit, from the chain alone.
//   node recheck.mjs <transaction-hash> <buyer-account>        e.g. … 7Hk3… buyer.cleartopay.testnet
//   node recheck.mjs --args submit-args.json [attestation.json] (offline: the submit_invoice arguments as JSON)
// It takes the `ai_reading` the Inbox attached to submit_invoice (the contract ignores it and decides on the
// signed objects only), and runs the same checks as the browser: the enclave's signature, that it is a reading of
// the signed document's fingerprint, NEAR AI's signature, OutLayer's attestation of our published code.
import fs from "node:fs";
const V = await import("../../docs/console/outlayer-verify.js");
const F = await import("../../docs/console/invoice-flow.js");
const RPC = process.env.NEAR_RPC || "https://test.rpc.fastnear.com";

export async function argsFromTx(hash, sender) {
  const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: [hash, sender] }) })).json();
  if (r.error) throw new Error(r.error.data || r.error.message);
  const call = r.result.transaction.actions.map((a) => a.FunctionCall).find((c) => c && c.method_name === "submit_invoice");
  if (!call) throw new Error("no submit_invoice in this transaction");
  return JSON.parse(Buffer.from(call.args, "base64").toString());
}
export async function recheck(args, attestation) {
  const x = args.ai_reading;
  if (!x || !x.output) return { ok: false, checks: [{ ok: false, label: "No AI reading rode along with this submit", detail: "the buyer submitted without the AI check" }] };
  const sha = Buffer.from(args.document_hash, "base64").toString("hex");
  const { reading, checks } = V.checkReading(x.output, sha);
  let att = attestation;
  if (!att && x.attestation_url) try { att = await (await fetch(V.READER.api + x.attestation_url)).json(); } catch {}
  const all = checks.concat(att ? V.checkAttestation(att, x.output) : [{ ok: false, label: "OutLayer's attestation", detail: "could not be fetched" }]);
  const cmp = F.compareReading(reading && reading.extraction, args.invoice);
  return { ok: all.every((c) => c.ok), checks: all, matches: cmp.every((c) => c.ok), compare: cmp, reader: x.reader };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const args = a[0] === "--args" ? JSON.parse(fs.readFileSync(a[1])) : await argsFromTx(a[0], a[1]);
  const r = await recheck(args, a[0] === "--args" && a[2] ? JSON.parse(fs.readFileSync(a[2])) : null);
  for (const c of r.checks.concat(r.compare || [])) console.log(`${c.ok ? "✓" : "✗"} ${c.label} · ${c.detail}`);
  console.log(r.ok ? (r.matches ? "\nThe reading is genuine and matches what the supplier signed." : "\nThe reading is genuine; it differs from what the supplier signed (see ✗).") : "\nThe reading did NOT verify.");
  process.exit(r.ok ? 0 : 1);
}
