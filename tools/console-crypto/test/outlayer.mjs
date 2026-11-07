// The OutLayer reader's proof files, checked offline with the same code Judge mode runs
// (docs/console/outlayer-verify.js). node test/outlayer.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const V = await import("../../../docs/console/outlayer-verify.js");
const dir = new URL("../../../docs/proof/outlayer/", import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, dir)));
const SHA = "3276bc7062369039adbd80623b11509903aeb30bd008a1e8b4407ff14faaf5bd"; // docs/console/samples/01-clean.pdf

const onchain = read("onchain-01-clean.json").output;
assert.ok(V.checkReading(onchain, SHA).checks.every((c) => c.ok), "the on-chain reading verifies");
const r = JSON.parse(onchain.reading);
assert.deepEqual([r.extraction.supplier_id, r.extraction.invoice_number, r.extraction.order_id, r.extraction.total, r.held.length], ["qingmar-steel", "INV-2208", "PO-1184", "7.80", 0]);
const bad = structuredClone(onchain); bad.reading = bad.reading.replace("7.80", "9.80");
assert.equal(V.checkReading(bad, SHA).checks[0].ok, false, "one changed byte breaks the enclave signature");
assert.equal(V.checkReading(onchain, "00".repeat(32)).checks[1].ok, false, "a reading of another file is refused");
const forged = structuredClone(onchain); forged.nearai.response = forged.nearai.response.replace("7.80", "7.81");
assert.equal(V.checkReading(forged, SHA).checks[3].ok, false, "NEAR AI's signature is re-checked from the bytes");

const att = read("attestation-https-01-clean.json");
const a = V.checkAttestation(att, {});
assert.ok(a[0].ok && a[2].ok, "our WASM ran, and the Intel TDX quote commits to the task");
const moved = { ...att, output_hash: "00".repeat(32) };
assert.equal(V.checkAttestation(moved, {})[2].ok, false, "a different output hash no longer matches the quote");
if (fs.existsSync(new URL("https-01-clean.json", dir))) {
  const h = read("https-01-clean.json");
  assert.ok(V.checkReading(h.output, SHA).checks.every((c) => c.ok), "the HTTPS reading verifies");
  assert.ok(V.checkAttestation(att, h.output).every((c) => c.ok), "the HTTPS reading is exactly the attested output");
  console.log("outlayer: HTTPS reading + its attestation: all checks pass");
}
console.log("outlayer: proof files verify");
