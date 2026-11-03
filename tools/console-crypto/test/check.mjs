// Checks the bundled crypto against near-api-js and the saved signed reading.
import fs from "node:fs";
import assert from "node:assert/strict";
import * as C from "../../../docs/console/crypto.js";
import { transactions, utils } from "near-api-js";
import { sha256 } from "@noble/hashes/sha256";

// 1. The signed transaction is byte-identical to near-api-js.
const kp = utils.KeyPair.fromRandom("ed25519");
const secret = kp.toString();
const blockHash = utils.serialize.base_encode(new Uint8Array(32).fill(7));
const args = { receipt_id: 3, note: "ünï" };
const mine = C.signFunctionCall({ secret, signerId: "judge-buyer.cleartopay.testnet", receiverId: "judge.cleartopay.testnet",
  nonce: 123456789012n, blockHash, methodName: "execute_payment", args, gas: 300_000_000_000_000n, deposit: 0n });
const tx = transactions.createTransaction("judge-buyer.cleartopay.testnet", kp.getPublicKey(), "judge.cleartopay.testnet",
  123456789012n, [transactions.functionCall("execute_payment", args, 300_000_000_000_000n, 0n)], utils.serialize.base_decode(blockHash));
const bytes = transactions.encodeTransaction(tx);
const sig = kp.sign(sha256(bytes));
const signed = new transactions.SignedTransaction({ transaction: tx, signature: new transactions.Signature({ keyType: 0, data: sig.signature }) });
assert.equal(mine.signedB64, Buffer.from(signed.encode()).toString("base64"));
assert.equal(mine.publicKey, kp.getPublicKey().toString());
console.log("ok  transaction bytes match near-api-js");

// 2. The enclave signature on the saved reading recovers to its signing address.
const r = JSON.parse(fs.readFileSync(new URL("../../../docs/proof/reading-INV-2208.json", import.meta.url)));
assert.equal(C.sha256Hex(r.request), r.evidence.request_sha256);
assert.equal(C.sha256Hex(r.response), r.evidence.response_sha256);
assert.equal(C.recoverPersonalSigner(r.evidence.signature.text, r.evidence.signature.signature), r.evidence.signature.signing_address.toLowerCase());
console.log("ok  reading signature recovers to", r.evidence.signature.signing_address);
