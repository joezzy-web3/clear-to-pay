# Demo data (fictional)

Everything in this folder is sample data for testnet. Qingmar Steel Co. is a fictional supplier.
Amounts are scaled down to fit faucet USDC: 1 tonne = 0.78 USDC.

| Case | What it is | Expected verdict |
|---|---|---|
| INV-2208 | 10 t delivered, 10 t billed, registered address | CLEARED (after the supplier's 72-hour wait) |
| INV-2209 | 10 t delivered, 12 t billed | HELD: quantity_exceeds_delivery |
| INV-2210 | "new bank details": payee not on file | SEIZED: payee_mismatch |

Each case has `invoice.json` (what the supplier signs), `delivery.json` (what the delivery signers
sign: a storekeeper and a weighbridge) and `document.txt` (the original document; only its sha-256
fingerprint goes on chain).

Arguments for `submit_invoice`, signed by the supplier and both delivery signers:

```bash
cd tools/ctp-sign
cargo run -q -- submit-args qingmar-supplier lagos-storekeeper:storekeeper,lagos-weighbridge:weighbridge \
  guard.cleartopay.testnet ../../demo/INV-2208/invoice.json ../../demo/INV-2208/delivery.json ../../demo/INV-2208/document.txt
```

Each signer signs with the role the buyer registered for it (`add_delivery_signer`). If the buyer has
set a delivery policy for the order, add `--policy-version N` (see `get_delivery_policy`).
