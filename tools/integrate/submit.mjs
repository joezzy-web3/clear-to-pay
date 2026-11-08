// Clear to Pay from your own agent: check what the key may do, then submit an invoice.
// The agent proposes; the contract decides. Nothing here can move money on its own.
//
//   cd tools/integrate && npm install
//   node submit.mjs                 # dry run: reads the key's fence on chain, prints the call
//   node submit.mjs --send          # sends it with the public Judge-mode key (testnet)
//   node submit.mjs --send --attack # a fooled agent: payee swapped. Expect SEIZED.
//
// With your own buyer account: CTP_ACCOUNT=buyer.example.testnet CTP_CONTRACT=pay.example.testnet
// CTP_KEY=ed25519:... (a function-call key, never a full-access one) and CTP_ARGS=invoice.json
// (the five signed objects: invoice, supplier_signature, delivery, delivery_signatures, document_hash).
import fs from "node:fs";
import { connect, keyStores, KeyPair, providers } from "near-api-js";

const here = (p) => new URL(p, import.meta.url);
const demo = JSON.parse(fs.readFileSync(here("../../docs/console/agent.json")));
const ACCOUNT = process.env.CTP_ACCOUNT || demo.account_id;
const CONTRACT = process.env.CTP_CONTRACT || demo.contract;
const KEY = process.env.CTP_KEY || demo.secret_key; // the demo key is public on purpose; yours goes in the environment
const send = process.argv.includes("--send"), attack = process.argv.includes("--attack");

// The signed objects. The demo ones are Judge mode's: numbered copies of INV-2208, signed by the supplier and two delivery roles.
let args;
if (process.env.CTP_ARGS) args = JSON.parse(fs.readFileSync(process.env.CTP_ARGS));
else {
  const cases = JSON.parse(fs.readFileSync(here("../../docs/console/cases.json")));
  args = structuredClone(cases.cases[Math.floor(Math.random() * cases.cases.length)]);
  if (attack) args.invoice.payee.address = cases.attacker_payee; // what a poisoned PDF would make an agent do
}

const keyPair = KeyPair.fromString(KEY);
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey("testnet", ACCOUNT, keyPair);
const near = await connect({ networkId: "testnet", nodeUrl: process.env.CTP_RPC || "https://test.rpc.fastnear.com", keyStore });

// 1. What may this key do? Ask NEAR, not a config file. Refuse anything wider than the fence.
const ak = await near.connection.provider.query({ request_type: "view_access_key", finality: "final", account_id: ACCOUNT, public_key: keyPair.getPublicKey().toString() });
const fc = ak.permission?.FunctionCall;
if (!fc) throw new Error("this is a full-access key: give the agent a function-call key instead");
const methods = [...fc.method_names].sort();
if (fc.receiver_id !== CONTRACT || methods.join() !== "execute_payment,submit_invoice") throw new Error(`key fence is ${fc.receiver_id} · ${methods.join(", ")}: expected ${CONTRACT} · execute_payment, submit_invoice`);
console.log(`key fence (read from NEAR): ${fc.receiver_id} · ${methods.join(", ")} · gas allowance ${fc.allowance == null ? "unlimited" : (Number(BigInt(fc.allowance) / 10n ** 18n) / 1e6).toFixed(3) + " NEAR"} · no deposit possible`);
console.log(`submit_invoice ${args.invoice.invoice_number} · ${args.invoice.total} units · payee ${args.invoice.payee.address}`);
if (!send) { console.log("dry run: add --send to submit"); process.exit(0); }

// 2. Submit. The contract checks signatures, the registered address, the order, the delivery and the limits.
const account = await near.account(ACCOUNT);
const outcome = await account.functionCall({ contractId: CONTRACT, methodName: "submit_invoice", args, gas: 300_000_000_000_000n, attachedDeposit: 0n });
const r = providers.getTransactionLastResult(outcome);
console.log(`receipt #${r.receipt_id}: ${r.verdict.toUpperCase()}${r.reasons.length ? " · " + r.reasons.join(", ") : ""}`);
console.log(`https://testnet.nearblocks.io/txns/${outcome.transaction.hash}`);
