# Clear to Pay SDK

Read, sign and submit to a Clear to Pay contract on NEAR. No dependencies: Node 18+ and browsers. The crypto is the same build the Console uses (`docs/console/crypto.js`; the test checks they are identical).

```js
import { ClearToPay, isClearToPay, signInvoice, signDelivery, submitArgs, documentHash } from "./sdk/index.js";

const ctp = new ClearToPay({ contract: "judge.cleartopay.testnet" });
await ctp.isGenuine();            // every server: the guard's exact code, no access keys
await ctp.order("PO-J1");          // the order on chain
await ctp.receipt(3);              // a verdict: CLEARED, HELD or SEIZED, with reasons

// a delivery signer, in their role, under the order's current policy version
const s1 = signDelivery({ secretKey, contract: ctp.contract, note, role: "storekeeper", policyVersion: 0 });
// the supplier, over the exact PDF bytes
const sig = signInvoice({ secretKey: supplierKey, contract: ctp.contract, invoice, document: pdfBytes });

// the agent, with its fenced key: refused before signing if the key can do more than submit_invoice / execute_payment
const { hash, value } = await ctp.submitInvoice({ account, secretKey: agentKey,
  args: submitArgs({ invoice, supplierSignature: sig, delivery: note, deliverySignatures: [s1, s2], documentHashB64: documentHash(pdfBytes) }) });
```

The SDK decides nothing. The contract checks every signature, the order, the delivery roles and the registered payee; the SDK only reads, signs and sends with the caller's own fenced key. Keep secret keys out of logs and repositories.

Test: `cd sdk && npm test` (offline: signs what the contract checks, verifies Judge mode's published signatures, refuses unfenced keys).
