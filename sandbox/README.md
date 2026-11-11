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
- `a_whole_order_is_set_up_in_one_signed_transaction_or_not_at_all`: the Console's New order wizard batch (new supplier, two signers, a 50-line order, delivery policy, limits) in one transaction; prints the gas NEAR burned against the wizard's per-action gas; a batch whose last action is refused leaves no trace of the others
- **The factory** (`tests/factory.rs`, needs `(cd factory && cargo near build non-reproducible-wasm)` first): `buyer_creates_a_locked_contract_they_own` (code byte for byte the guard's, the caller as owner, no keys, a stranger cannot pause it), `a_taken_name_refunds_the_buyer_in_full`, `bad_requests_are_refused_and_cost_only_gas`, `only_the_factory_can_report_results`

The wasm is byte-for-byte the deployed code. To get past the supplier's 72-hour wait, the two
paying tests rewrite that one stored time on the local node (state patching, which only a sandbox
allows); a local node moves about 0.4 s of block time per fast-forwarded block, so waiting it out
would take hours. The 72-hour rule's own logic is proven by the unit tests and is live on testnet.
(Until 2 November evening the sandbox used a special short-wait build; the external review rightly
called its account-name guard a weak boundary, CTP6-05, so it was removed.)

Run (from the repository root; needs cargo-near and downloads the near-sandbox binary):

```bash
cargo near build non-reproducible-wasm
(cd sandbox/token && cargo near build non-reproducible-wasm --no-abi)
cargo build --manifest-path tools/ctp-sign/Cargo.toml
(cd factory && cargo near build non-reproducible-wasm)
(cd sandbox && cargo test -- --test-threads=1)
```

In CI: Actions → **sandbox** → Run workflow. First green run: 2 Nov 2026, 6 passed in 131 s (with the short-wait build, since removed). The token in `token/` is for these tests only.
