# Sandbox tests: Clear to Pay on a real NEAR node

The contract's 127 unit tests run on a mock chain. These deploy the real contract wasm into
**near-sandbox** (a local NEAR node), next to a real NEP-141 token, and run what only a real
chain can show: the deposit hook, a payout and its callback, a payout the token refuses (the
money must come back to the pool), the 72-hour wait in block time, and the agent's
function-call key being refused by NEAR itself. Signatures come from the real `ctp-sign`.

- `an_honest_invoice_is_held_until_the_supplier_wait_ends_then_clears_and_pays`: HELD before the wait; CLEARED after; exactly 7.80 to the supplier; pool and contract balance agree; paying twice is SEIZED
- `new_bank_details_are_seized_even_with_every_signature_valid`: SEIZED `payee_mismatch`, no payment, pool untouched
- `one_signer_and_over_billing_are_held_on_chain_too`: HELD `delivery_signatures_missing` and `quantity_exceeds_delivery`
- `a_payout_that_fails_returns_the_money_to_the_pool_and_can_be_retried`: FAILED, every unit back in the pool; reauthorised, it pays
- `near_itself_refuses_what_the_agent_key_must_not_do`: withdraw, change limits, move USDC, attach a deposit: all refused
- `deposits_from_anyone_but_the_buyer_are_sent_back`: refunded in full

One deliberate difference from the deployed code: the sandbox build (`--features sandbox-short-wait`)
waits 2 minutes instead of 72 hours before a new supplier is payable, because a local node only
moves about 0.3 s of block time per fast-forwarded block. That build refuses to run on any account
outside the sandbox's `test.near`, so it cannot be deployed by mistake. The 72-hour rule is proven
by the unit tests and is live on testnet.

Run (from the repository root; needs cargo-near and downloads the near-sandbox binary):

```bash
cargo near build non-reproducible-wasm --features sandbox-short-wait --out-dir target/near-sandbox
(cd sandbox/token && cargo near build non-reproducible-wasm --no-abi)
cargo build --manifest-path tools/ctp-sign/Cargo.toml
(cd sandbox && cargo test -- --test-threads=1)
```

In CI: Actions → **sandbox** → Run workflow. The token in `token/` is for these tests only.
