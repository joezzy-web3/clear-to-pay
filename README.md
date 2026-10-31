# Clear to Pay

**A payment guardrail for AI agents.** The AI reads invoices. Code decides. No invoice gets paid until it clears.

Built for the NEAR Hackathon (1–14 November 2026). Work in progress: this README lists only what is already built and proven, and says so where something is still to come.

---

## For reviewers

**What runs today** (NEAR testnet, contract `guard.cleartopay.testnet`, owned by `buyer.cleartopay.testnet`; v2, redeployed with the security-review fixes on 30 Oct; the first verdicts below ran on v1, `cleartopay.testnet`):

- An agent submits a supplier invoice. The contract checks it against the purchase order, a storekeeper-signed delivery note, the supplier registry, duplicates and limits, and stamps it **CLEARED**, **HELD** or **SEIZED**, with reasons and a permanent receipt.
- A CLEARED invoice pays real testnet USDC (Circle) to the supplier's **registered** address, through fixed payment states.
- The agent's key is a NEAR function-call key: it can call only `submit_invoice` and `execute_payment`, cannot attach deposits, and cannot touch any other contract.

**Run it yourself:**

```bash
cargo test                        # 91 contract tests, incl. 3 property tests (~1,300 random cases)
(cd tools/ctp-sign && cargo test) # 5 signing-tool tests, incl. golden vectors shared with the contract
cargo near build non-reproducible-wasm
```

Every transaction mentioned below is listed in [docs/testnet-proof.md](docs/testnet-proof.md) and can be opened at `https://testnet.nearblocks.io/txns/<id>`.

## Claims and proof

| Claim | Enforced in | Proof |
|---|---|---|
| A fooled AI cannot redirect money: payment goes only to the supplier's registered route | `inspection.rs` (payee check), `payments.rs` (`try_pay` re-checks the route) | Tests `attack_ai_fooled_into_writing_the_attackers_address_is_seized`, `if_the_route_changes_before_payment_the_old_one_is_not_paid`; testnet (v1): INV-2210 **SEIZED** (`payee_mismatch`), tx `7WyaoQhm…` |
| Billing more than was delivered is held | `inspection.rs` | Test `billing_more_than_was_delivered_is_held`; testnet (v1): INV-2209 **HELD**, tx `4NAEWuuj…` |
| Changing a supplier's payout address needs the supplier's signature, the buyer's approval and 72 hours | `lib.rs` (registry) | Registry tests in `src/tests.rs`, incl. wrong key, edited address, replayed nonce, signature for another contract |
| A new supplier cannot be paid for 72 hours | `lib.rs` | Test `new_supplier_is_not_payable_for_72_hours`; testnet (v2): `payable_route` is `null` until Mon 2 Nov 2026 23:29 Lagos |
| The same invoice, document or delivery note is never paid twice | `inspection.rs` | Tests `attack_paying_the_same_invoice_twice_is_seized`, `attack_renumbered_copy_of_a_paid_document_is_seized`, `attack_reusing_one_delivery_for_two_invoices_is_seized` |
| A forged copy cannot block the real invoice, even if it carries the real document's fingerprint | `inspection.rs` (the supplier signs the fingerprint; only authenticated documents are remembered) | Tests `a_forged_copy_cannot_block_the_real_invoice`, `attack_forged_invoice_cannot_poison_legitimate_document_hash` |
| One person cannot play both supplier and storekeeper | `lib.rs`, `inspection.rs` (keys must differ, checked at registration and at submission) | Tests `attack_supplier_key_cannot_be_registered_as_a_storekeeper`, `attack_storekeeper_key_cannot_be_registered_as_a_supplier` |
| A failed or expired payment can be retried, once, only by the buyer, and only to the current registered route | `payments.rs` (`reauthorize_payment`) | Tests `failed_payment_can_be_reauthorized_and_is_sent_once`, `reauthorized_payment_goes_to_the_current_route_after_an_approved_change` |
| A hijacked agent cannot fill the contract's storage | `inspection.rs` (daily submission limit, 1–1000, default 100) | Test `agent_cannot_exhaust_contract_storage_beyond_the_daily_limit` |
| Splitting an invoice to dodge the limit fails | `inspection.rs` | Test `attack_splitting_invoices_to_dodge_the_limit_hits_the_period_limit` |
| Payments only move through legal states; nothing is paid twice | `payments.rs` (`set_status`) | Tests `a_settled_payment_can_never_be_paid_again`, `a_callback_cannot_settle_the_same_payment_twice` |
| The operator has no backdoor: no function can send funds anywhere but the registered supplier or back to the buyer | `payments.rs` (`withdraw` pays the owner only, never reserved funds) | Tests `withdraw_only_pays_the_owner_and_never_touches_reserved_money`, `withdraw_cannot_take_reserved_money` |
| The agent key cannot attach money or call owner actions | NEAR access-key rules + 1-yocto owner methods | Key permissions on chain, v2 tx `2GQ6or4U…` (v1 `8HpViCur…`); refused attempts are reproducible (see proof log) |
| The money rules hold for random inputs, not just chosen cases | `src/property_tests.rs` (proptest) | 300 random sequences of up to 40 actions (deposit, submit, pay, fail, cancel, retry, resolve, withdraw, wait), checked after every step: a payee not on file never clears; available + reserved + withdrawals in flight always equal the tokens held; no invoice is paid twice; nothing clears beyond delivery or order. Plus 1,000 random edits to a signed invoice, its fingerprint or its signature: none clears. Checked against deliberately broken builds: disabling the payee check or the refund on a failed transfer makes these tests fail. |
| Signatures are bound to this contract and message type | Domain-separated sha-256 digests | Golden vectors in `src/vector_tests.rs` and `tools/ctp-sign`; test `attack_signature_made_for_another_contract_is_rejected` |
| Invisible characters and lookalike letters are rejected in ids and addresses | `lib.rs` (validation) | Tests `addresses_with_invisible_characters_are_rejected`, `supplier_ids_with_lookalike_letters_are_rejected` |

## NEAR stack used

| Piece | Where |
|---|---|
| near-sdk 5.29 smart contract | `src/` |
| Function-call access keys (the agent's fence) | `buyer.cleartopay.testnet`, see proof log |
| NEP-141 token payments (Circle USDC on testnet) | `src/payments.rs` |
| NEP-297 events for every decision | `emit()` in `src/lib.rs` |

Still to come, and not claimed above: the AI invoice reader on NEAR AI Cloud, cross-chain payouts through NEAR Intents, the shared seizure list, the live ledger page.

## What it does not do

- The **first** confirmation of a supplier's address still depends on the buyer checking it out of band (for example, a call to a number already on file). After that, only the supplier's key can change it, and every change waits 72 hours.
- Tax withholding, national e-invoicing systems and local rules on stablecoin payments are out of scope.
- This is hackathon code. It has not been professionally audited. It runs on testnet and, later, with small mainnet amounts only.

## Security review

On 30 October 2026 the code and the planned designs were given to an independent AI auditor with an attacker's brief. Its findings and what we did:

| Finding | Severity | Outcome |
|---|---|---|
| A forged submission could claim the real invoice's document fingerprint and get the real invoice seized | High | **Fixed.** The fingerprint is now inside the supplier's signature, and a SEIZED document is remembered only if the supplier's signature on it was valid. |
| The same key could be registered as supplier and storekeeper, so one compromised party could vouch for its own delivery | High | **Fixed.** Rejected at registration both ways; held at submission if it ever happens. |
| A FAILED or EXPIRED payment had no way back, so a cleared invoice could never be paid | Medium | **Fixed.** `reauthorize_payment`: buyer only, from FAILED, EXPIRED or CANCELLED, re-bound to the supplier's current payable route, attempt counted. |
| A payout whose callback never ran would stay reserved for ever | Medium | **Fixed.** Callbacks must follow a transfer (`promise_results_count == 1`), and after 24 hours the buyer can resolve a stuck payment with `resolve_stuck_payment`, recorded as an event. This sends no money anywhere: it only releases the reservation, and the buyer's answer is on the public record. A late callback is then refused. |
| A hijacked agent could submit without limit and fill storage | Medium | **Fixed.** Daily submission limit. |
| Two balance additions were unchecked | Low | **Fixed.** Checked arithmetic everywhere money is counted. |
| Secret-scan exceptions matched whole lines, so a secret next to a public value would pass | Medium | **Fixed.** Exact-value exceptions; CI plants fake secrets beside public values on every run and fails if any gets through. |
| CI used moving tags and an unverified download | Low | **Fixed.** Actions pinned to commit SHAs; the gitleaks binary is checked against its sha-256. |
| The signing tool signed whatever it was given | Low | **Fixed.** It shows payee, total and lines and asks before signing; it refuses one key for both roles. |
| Account names mean different things on testnet and mainnet | Info | **Documented.** Signatures include the contract account, and mainnet will use a fresh contract account and fresh keys. |
| Period limits use fixed windows, not rolling ones | Info | **Documented** and tested (`period_limit_uses_fixed_windows_as_documented`). Choose the period with that in mind. |
| The buyer can withdraw unreserved money before an AUTHORIZED payment is reserved | Info | **By design.** Only reserved money is protected; an AUTHORIZED payment that finds no funds waits, and is visible as such. |
| The owner key can redeploy the contract | Info | **Disclosed.** During the hackathon the owner holds the deploy key. After it, upgrades move behind a time-locked multisig, or the deploy key is removed. |

## Security notes

- Owner actions require exactly 1 yoctoNEAR, so a function-call key can never call them.
- CI runs formatting, strict lints, all tests, a wasm build, `cargo audit` and a secret scan over the full history on every push. Four advisories in host-side test tooling are documented exceptions in `.cargo/audit.toml`; none is in the deployed contract.
- Keys made by `ctp-sign` live in `~/.config/clear-to-pay/keys`, outside the repository.
- Supplier and storekeeper must hold different keys.
- **Upgrades:** the account that owns the contract can deploy new code, as on any NEAR account with a full-access key. This is the one power above the rules described here, and it is disclosed rather than hidden; see the table above for the plan.

## Timeline

Design and research from 20 October 2026; code from 30 October 2026, as the hackathon rules allow ("code written since the announcement counts"). The commit history is the record.

## Demo data

Everything in `demo/` is fictional. Qingmar Steel Co. is not a real company. Amounts are scaled to faucet USDC.

## Licence

MIT
