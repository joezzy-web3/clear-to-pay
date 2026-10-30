# Demo data (fictional)

Everything in this folder is sample data for testnet. Qingmar Steel Co. is a fictional supplier.
Amounts are scaled down to fit faucet USDC: 1 tonne = 0.78 USDC.

| Case | What it is | Expected verdict |
|---|---|---|
| INV-2208 | 10 t delivered, 10 t billed, registered address | CLEARED (after the supplier's 72-hour wait) |
| INV-2209 | 10 t delivered, 12 t billed | HELD: quantity_exceeds_delivery |
| INV-2210 | "new bank details": payee not on file | SEIZED: payee_mismatch |

Each case has `invoice.json` (what the supplier signs), `delivery.json` (what the storekeeper signs)
and `document.txt` (the original document; only its sha-256 fingerprint goes on chain).
