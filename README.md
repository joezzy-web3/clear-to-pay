# Clear to Pay

**A payment guardrail for AI agents.** The AI reads invoices. Code decides. No invoice gets paid until it clears.

Built for the NEAR Hackathon (1–14 November 2026). Work in progress: this README lists only what is already built and proven, and says so where something is still to come.

---

## For reviewers

**What runs today** (NEAR testnet, contract `guard.cleartopay.testnet`, owned by `buyer.cleartopay.testnet`; v2, redeployed with the security-review fixes on 30 Oct; the first verdicts below ran on v1, `cleartopay.testnet`):

- An agent submits a supplier invoice. The contract checks it against the purchase order, a delivery note signed by two different people (e.g. storekeeper and weighbridge), the supplier registry, duplicates and limits, and stamps it **CLEARED**, **HELD** or **SEIZED**, with reasons and a permanent receipt.
- A CLEARED invoice pays real testnet USDC (Circle) to the supplier's **registered** address, through fixed payment states.
- The agent's key is a NEAR function-call key: it can call only `submit_invoice` and `execute_payment`, cannot attach deposits, and cannot touch any other contract.

**Run it yourself:**

```bash
cargo test                        # 122 contract tests, incl. 4 property tests (~2,300 random cases)
(cd tools/ctp-sign && cargo test) # 5 signing-tool tests, incl. golden vectors shared with the contract
(cd reader && python3 -m pytest -q) # 118 reader tests, incl. the 19-invoice attack corpus
scripts/mutation-check.sh         # breaks the contract on purpose; the property test must catch it
cargo near build non-reproducible-wasm
```

**Live site:** [joezzy-web3.github.io/clear-to-pay](https://joezzy-web3.github.io/clear-to-pay/) (the landing page reads its verdict counts, the inspection card and the record in "Proof" from the contract) and the **ledger** at [/ledger](https://joezzy-web3.github.io/clear-to-pay/ledger/): every receipt with its verdict and reasons, the pool, the limits, the supplier's locked address and its countdown, and a box that fingerprints a document in your browser and finds its receipt. Both read NEAR testnet directly from the browser: no server, no keys. Source: [docs/](docs/).

Every testnet transaction mentioned below is listed in [docs/testnet-proof.md](docs/testnet-proof.md) and can be opened at `https://testnet.nearblocks.io/txns/<id>`. Tests run locally and in CI; they are not on-chain transactions.

## Claims and proof

| Claim | Enforced in | Proof |
|---|---|---|
| A fooled AI cannot redirect money: payment goes only to the supplier's registered route | `inspection.rs` (payee check), `payments.rs` (`try_pay` re-checks the route) | Tests `attack_ai_fooled_into_writing_the_attackers_address_is_seized`, `if_the_route_changes_before_payment_the_old_one_is_not_paid`; testnet (v1): INV-2210 **SEIZED** (`payee_mismatch`), tx `7WyaoQhm…` |
| Billing more than was delivered is held | `inspection.rs` | Test `billing_more_than_was_delivered_is_held`; testnet (v1): INV-2209 **HELD**, tx `4NAEWuuj…` |
| Changing a supplier's payout address needs the supplier's signature, the buyer's approval and 72 hours | `lib.rs` (registry) | Registry tests in `src/tests.rs`, incl. wrong key, edited address, replayed nonce, signature for another contract |
| A new supplier cannot be paid for 72 hours | `lib.rs` | Test `new_supplier_is_not_payable_for_72_hours`; testnet (v2): `payable_route` is `null` until Mon 2 Nov 2026 23:29 Lagos |
| The same invoice, document or delivery note is never paid twice | `inspection.rs` | Tests `attack_paying_the_same_invoice_twice_is_seized`, `attack_renumbered_copy_of_a_paid_document_is_seized`, `attack_reusing_one_delivery_for_two_invoices_is_seized` |
| A forged copy cannot block the real invoice, even if it carries the real document's fingerprint | `inspection.rs` (the supplier signs the fingerprint; only authenticated documents are remembered) | Tests `a_forged_copy_cannot_block_the_real_invoice`, `attack_forged_invoice_cannot_poison_legitimate_document_hash` |
| One person cannot confirm a delivery alone | `inspection.rs` (`set_delivery_policy`, `add_delivery_signer`; two distinct roles by default) | Each delivery signer signs the note together with its registered role and the order's policy version. A missing, repeated, unregistered, removed, forged, stale or supplier signature means HELD. 19 tests in `src/delivery_tests.rs` (e.g. `one_signature_alone_is_held`, `signatures_from_two_different_notes_cannot_be_mixed`, `signatures_made_under_an_old_policy_stop_counting`), and property test `property_a_delivery_needs_exactly_two_valid_roles`: 1,000 random mixes of good and bad signatures, only the honest pair clears |
| One person cannot play both supplier and delivery signer | `lib.rs`, `inspection.rs` (keys must differ, checked at registration and at submission) | Tests `attack_supplier_key_cannot_be_registered_as_a_storekeeper`, `attack_storekeeper_key_cannot_be_registered_as_a_supplier` |
| A failed or expired payment can be retried, once, only by the buyer, and only to the current registered route | `payments.rs` (`reauthorize_payment`) | Tests `failed_payment_can_be_reauthorized_and_is_sent_once`, `reauthorized_payment_goes_to_the_current_route_after_an_approved_change` |
| A hijacked agent cannot fill the contract's storage | `inspection.rs` (daily submission limit, 1–1000, default 100) | Test `agent_cannot_exhaust_contract_storage_beyond_the_daily_limit` |
| Splitting an invoice to dodge the limit fails | `inspection.rs` | Test `attack_splitting_invoices_to_dodge_the_limit_hits_the_period_limit` |
| Payments only move through legal states; nothing is paid twice | `payments.rs` (`set_status`) | Tests `a_settled_payment_can_never_be_paid_again`, `a_callback_cannot_settle_the_same_payment_twice` |
| The operator has no backdoor: no function sends tokens anywhere but the registered supplier or back to the buyer (recovery of a lost transfer result is covered separately below) | `payments.rs` (`withdraw` pays the owner only, never reserved funds) | Tests `withdraw_only_pays_the_owner_and_never_touches_reserved_money`, `withdraw_cannot_take_reserved_money` |
| The agent key cannot attach money or call owner actions | NEAR access-key rules + 1-yocto owner methods | Key permissions on chain, v2 tx `2GQ6or4U…` (v1 `8HpViCur…`); refused attempts are reproducible (see proof log) |
| The money rules hold for random inputs, not just chosen cases | `src/property_tests.rs` (proptest) | 300 random sequences of up to 40 actions (deposit, submit, pay, fail, cancel, retry, resolve, withdraw, wait), checked after every step: a payee not on file never clears; available + reserved + withdrawals in flight always equal the tokens held (the model assumes tokens arrive only through `ft_transfer_call` deposits; tokens sent with a plain `ft_transfer` are not on the books, see Limitations); no invoice is paid twice; nothing clears beyond delivery or order. Plus 1,000 random edits to a signed invoice, its fingerprint or its signature: none clears. Checked against deliberately broken builds, reproducibly: `scripts/mutation-check.sh` removes the payee check, the refund on a failed transfer, and the two-person delivery rule, one at a time in a throwaway copy, and requires a property test to fail each time (3 of 3 caught). |
| Hidden instructions in an invoice never reach the AI | `reader/` (intake, normalize) | 19-invoice attack corpus in `reader/corpus/`: white, tiny, invisible, off-page, low-contrast and fully or partly painted-over text that mentions payment is dropped and the invoice HELD; zero-width, right-to-left and lookalike-letter tricks HELD; every case decided before any model call. Tests in `reader/tests/` |
| The AI cannot choose the payee | `reader/ctp_reader/schema.py` | Its answer has no payee field; any extra field is rejected, never repaired; the payee is the registered route and the token comes from the order. Test `test_a_well_formed_answer_becomes_exactly_the_invoice_the_supplier_signs` |
| Signatures are bound to this contract and message type | Domain-separated sha-256 digests | Golden vectors in `src/vector_tests.rs` and `tools/ctp-sign`; test `attack_signature_made_for_another_contract_is_rejected` |
| Invisible characters and lookalike letters are rejected in ids and addresses | `lib.rs` (validation) | Tests `addresses_with_invisible_characters_are_rejected`, `supplier_ids_with_lookalike_letters_are_rejected` |

## NEAR stack used

| Piece | Where |
|---|---|
| near-sdk 5.29 smart contract | `src/` |
| Function-call access keys (the agent's fence) | `buyer.cleartopay.testnet`, see proof log |
| NEP-141 token payments (Circle USDC on testnet) | `src/payments.rs` |
| NEP-297 events for every decision | `emit()` in `src/lib.rs` |

Still to come, and not claimed above: the model call on NEAR AI Cloud (the reader's document checks and answer validation above are built), the rendered-image check, cross-chain payouts through NEAR Intents, the shared seizure list.

## What it does not do

- The **first** confirmation of a supplier's address still depends on the buyer checking it out of band (for example, a call to a number already on file). After that, a change needs the supplier's signature and the buyer's approval, and only takes effect 72 hours later.
- Tax withholding, national e-invoicing systems and local rules on stablecoin payments are out of scope.
- Tokens sent to the contract with a plain `ft_transfer` (instead of `ft_transfer_call`) are not counted in the pool. They are never lost, but while they sit there a lost transfer result cannot be resolved from the balance and stays reserved (it fails closed). If such tokens exactly offset a payout whose result was lost, the contract records it as FAILED; a repeat payout can then only be funded by those tokens, never by the buyer's deposit (test `attack_returned_tokens_can_fund_a_repeat_payout_but_never_the_buyers_money`).
- This is hackathon code. It has not been professionally audited. It runs on testnet and, later, with small mainnet amounts only.

## Security review

On 30 October 2026 the code and the planned designs were given to an independent AI auditor with an attacker's brief. Its findings and what we did:

| Finding | Severity | Outcome |
|---|---|---|
| A forged submission could claim the real invoice's document fingerprint and get the real invoice seized | High | **Fixed.** The fingerprint is now inside the supplier's signature, and a SEIZED document is remembered only if the supplier's signature on it was valid. |
| The same key could be registered as supplier and storekeeper, so one compromised party could vouch for its own delivery | High | **Fixed.** Rejected at registration both ways; held at submission if it ever happens. |
| A FAILED or EXPIRED payment had no way back, so a cleared invoice could never be paid | Medium | **Fixed.** `reauthorize_payment`: buyer only, from FAILED, EXPIRED or CANCELLED, re-bound to the supplier's current payable route, attempt counted. |
| A payout whose callback never ran would stay reserved for ever | Medium | **Fixed.** Callbacks must follow a transfer (`promise_results_count == 1`), and after 24 hours the buyer can resolve a stuck payment with `resolve_stuck_payment`, recorded as an event. This sends no money anywhere. (Since the second review the buyer states nothing: the contract reads its own balance; the attempt and the contract's result are recorded as events.) A late callback is then refused. |
| A hijacked agent could submit without limit and fill storage | Medium | **Fixed.** Daily submission limit. |
| Two balance additions were unchecked | Low | **Fixed.** Checked arithmetic everywhere money is counted. |
| Secret-scan exceptions matched whole lines, so a secret next to a public value would pass | Medium | **Fixed.** Exact-value exceptions; CI plants fake secrets beside public values on every run and fails if any gets through. |
| CI used moving tags and an unverified download | Low | **Fixed.** Actions pinned to commit SHAs; the gitleaks binary is checked against its sha-256. |
| The signing tool signed whatever it was given | Low | **Fixed.** It shows payee, total and lines and asks before signing; it refuses one key for both roles. |
| Account names mean different things on testnet and mainnet | Info | **Documented.** Signatures include the contract account, and mainnet will use a fresh contract account and fresh keys. |
| Period limits use fixed windows, not rolling ones | Info | **Documented** and tested (`period_limit_uses_fixed_windows_as_documented`). Choose the period with that in mind. |
| The buyer can withdraw unreserved money before an AUTHORIZED payment is reserved | Info | **By design.** Only reserved money is protected; an AUTHORIZED payment that finds no funds waits, and is visible as such. |
| The owner key can redeploy the contract | Info | **Disclosed.** During the hackathon the owner holds the deploy key. After it, upgrades move behind a time-locked multisig, or the deploy key is removed. |

### Second review (31 October 2026)

The same auditor reviewed patches 1–10. It rated payee control, role separation, document-bound signatures and the secret scan as passing, and found:

| Finding | Severity | Outcome |
|---|---|---|
| CTP-01: resolving a stuck payment took the buyer's word, so a wrong answer could lead to a second payment | High | **Fixed.** The buyer states nothing: the contract reads its own token balance on chain. Money returns to the pool only if the balance proves it never left; it is SETTLED only if the balance proves it left and no other transfer is in flight; any other balance leaves it reserved. Tests `resolution_reads_the_balance_and_refunds_only_if_the_money_never_left`, `attack_unknown_outcome_is_never_treated_as_failure`, `with_two_payouts_in_flight_a_lower_balance_proves_nothing`, and the property test, which now models transfers that have landed but are not yet recorded. |
| CTP-02: a payout result was matched to the receipt, not the attempt | High | **Fixed.** Every result carries its attempt number; one from an earlier attempt is refused. Test `attack_stale_payout_result_from_an_earlier_attempt_cannot_touch_the_current_one`, plus random stale results in the property test. (On NEAR a transfer's result arrives within blocks, so this is defence in depth.) |
| F8 follow-up: one reservation addition was unchecked | Low | **Fixed.** |
| CTP-08: signatures do not name the network | Medium | **Fixed differently.** Signatures name the contract account; `new` now refuses implicit accounts, the only kind that exist on every network. Named `.testnet` and `.near` accounts cannot collide. Test `contract_refuses_an_implicit_account_that_exists_on_every_network`. |
| CTP-09: storage can grow until the contract cannot write | Medium | **Fixed.** Submissions stop while the contract has less than 0.05 NEAR free, so cancellations, withdrawals and payout results can always be recorded. The agent key's 0.25 NEAR gas allowance also caps how many calls it can ever make. Test `submissions_stop_before_the_contract_runs_out_of_storage_money`. |
| CTP-03: an image-only scan skipped the scanned-document hold | Medium | **Fixed.** Corpus case 15. |
| CTP-04: text half covered by a box passed the centre-point test | Medium | **Fixed.** A glyph a quarter or more under later paint is hidden. Corpus case 16. |
| CTP-07: white text on a dark bar was a false alarm; outline text was judged by the wrong colour | Medium | **Fixed.** Visibility is contrast against what is painted behind; outline text uses its outline colour. This also catches grey text on a same-grey box. Corpus cases 17, 18, 19. |
| CTP-05: no isolation for hostile PDFs | Medium | **Fixed.** Parsing runs in a child process with memory, CPU and file-write limits; the tested decompression bomb is held, not fatal. Network isolation is a deployment requirement. (Strengthened after the third review, below.) |
| CTP-06: the Chinese amount parser accepted 壹拾拾元 as 20 | Medium | **Fixed.** Strict grammar; ambiguous colloquial forms (贰佰伍) are refused, not guessed. |
| CTP-10: Python dependencies not hash-locked | Low | **Fixed.** CI installs with `--require-hashes`. |
| `--yes` in the signing tool bypasses confirmation | Info | **Documented.** The signing tool holds supplier and storekeeper keys; the buyer's agent never has them. |
| A QR code in an invoice could carry an attacker's address (our own question) | — | Images are never decoded and the payee is always the registered route. Corpus case 14. |

### Third review (31 October 2026)

The same auditor reviewed patches 1–20, including the website. It found no High or Critical issue, confirmed the attempt binding, the checked arithmetic and the implicit-account rule, and found no way to inject script through on-chain data. Findings:

| Finding | Severity | Outcome |
|---|---|---|
| CTP3-01: a payout whose result was lost, offset exactly by tokens sent back with a plain `ft_transfer`, resolves as FAILED | Medium | **Bounded and documented.** A balance cannot tell these apart. A retry still needs the buyer, and can only be funded by the returned tokens, never the buyer's deposit. Test `attack_returned_tokens_can_fund_a_repeat_payout_but_never_the_buyers_money`; see "What it does not do". |
| CTP3-02: an upgrade made while a transfer is in flight could find its counter missing and leave the payment stuck | Medium | **Fixed.** A missing counter is logged (`in_flight_counter_mismatch`) and the result is still recorded. Upgrades are made only when `get_in_flight` reads zero (`scripts/upgrade-in-place.sh` refuses otherwise). Tests `a_payout_result_is_recorded_even_if_its_in_flight_counter_is_missing`, `a_stuck_payment_can_be_resolved_even_if_its_in_flight_counter_is_missing`. |
| CTP3-03: the reader's child process was resource-limited but not isolated | Medium | **Fixed as far as a library can.** The child gets the document on stdin (no path), an empty environment (no API keys), an empty working folder, at most 64 open files, no data writes, and on Linux no network (its own empty network namespace). It still runs as the same OS user: production runs it as a dedicated user or container. Tests `test_the_parser_inherits_no_environment`, `test_the_parser_has_no_network`, `test_the_parser_cannot_write_data_to_disk`. |
| CTP3-04: the parent read the whole file before any limit applied; worker output was unbounded | Medium | **Fixed.** Size is checked before reading (10 MB); output is capped at 4 MB; a worker that reports a different fingerprint is not believed. Tests `test_oversized_file_is_held_before_it_is_read_or_parsed`, `test_worker_output_is_capped`, `test_a_worker_that_lies_about_the_document_is_not_believed`. |
| CTP3-05: the isolation crashed on Windows | Low | **Fixed.** Unsupported systems HOLD the invoice (`isolation_unsupported_platform`). Test `test_unsupported_platform_holds_instead_of_crashing`. |
| CTP3-06: the website trusts whichever RPC server answers first | Low | **Fixed.** Each receipt names the server that reported it and links to NearBlocks; the document check says what a match proves and what it does not. We also found that a hostile server or a tampered cache could have passed markup to the page: everything received is now checked against the exact shape the contract produces and dropped otherwise. |
| Design review of the planned second delivery signature | — | **Built to the review's rules** (one role per key, distinct keys and roles, signatures bound to contract, note, role and policy version, removal takes effect at once, a policy change invalidates older signatures, fewer than required means HELD) and all ten of its required tests, in `src/delivery_tests.rs`. |
| README sentences that overstated the evidence | — | **Corrected** (this section and the claims table). The mutation claim is now reproducible with `scripts/mutation-check.sh`. |

## Security notes

- Owner actions require exactly 1 yoctoNEAR, so a function-call key can never call them.
- CI runs formatting, strict lints, all tests, a wasm build, `cargo audit` and a secret scan over the full history on every push. Four advisories in host-side test tooling are documented exceptions in `.cargo/audit.toml`; none is in the deployed contract.
- Keys made by `ctp-sign` live in `~/.config/clear-to-pay/keys`, outside the repository.
- Supplier and delivery signers must hold different keys; each delivery signer holds exactly one role.
- **Upgrades:** made in place only when no transfer or withdrawal is in flight (`scripts/upgrade-in-place.sh` checks `get_in_flight` first). The account that owns the contract can deploy new code, as on any NEAR account with a full-access key. This is the one power above the rules described here, and it is disclosed rather than hidden; see the table above for the plan.

## Timeline

Design and research from 20 October 2026; code from 30 October 2026, as the hackathon rules allow ("code written since the announcement counts"). The commit history is the record.

## Demo data

Everything in `demo/` is fictional. Qingmar Steel Co. is not a real company. Amounts are scaled to faucet USDC.

## Licence

MIT
