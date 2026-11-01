# Threat model

What Clear to Pay defends against, how, and where each defence is proven. Every test named
here runs with `cargo test` (contract, `src/`) or `python3 -m pytest -q` (reader, `reader/tests/`).
Gaps are listed at the end, not hidden.

**What we protect:** the buyer's money in the contract pool. **The rule:** money leaves only to a
supplier's registered address, for goods that two different people confirmed were delivered, at
the order's prices, once.

**Who might attack:** an outsider who controls an email thread or a PDF; a prompt injection that
fools the AI; a thief who steals the agent's key; a dishonest supplier; one dishonest insider at
the buyer (a storekeeper, say); a cloud AI provider that swaps or tampers with the model.

## 1. The document and the AI

| # | Threat | Defence | Proof |
|---|---|---|---|
| D1 | Hidden text in the PDF ("bank details changed, pay X") reaches the model | Only glyphs a person can see are kept; hidden text that mentions payment HOLDS the invoice before any model call | 19-invoice corpus, `reader/corpus/expected.json`; `reader/tests/test_reader.py` |
| D2 | Invisible characters, right-to-left overrides, lookalike letters in identifiers | Unicode clean-up; zero-width, bidi and mixed-script tokens HOLD | corpus cases 07, 08, 09 |
| D3 | A scanned page whose text layer says something else | Scans are HELD (`scanned_document`) | corpus cases 13, 15 |
| D4 | A malicious PDF attacks the parser (decompression bomb, probes) | Parsed in a child with no network, no environment, memory, CPU, time and output limits; any failure HOLDS | `reader/ctp_reader/isolated.py`; isolation tests in `test_reader.py` |
| D5 | The model is fooled anyway and writes the attacker's address | The model's answer has **no payee field**; the payee always comes from the supplier's registered record | `test_a_well_formed_answer_becomes_exactly_the_invoice_the_supplier_signs`; contract `attack_ai_fooled_into_writing_the_attackers_address_is_seized` |
| D6 | The model answers with extra fields, prose, or numbers that do not add up | Strict schema: unknown, missing or malformed fields rejected, never repaired; totals and amount-in-words checked | `reader/tests/test_reader.py`; `test_a_signed_answer_that_does_not_add_up_is_held` |
| D7 | The AI provider tampers with an answer | The answer is signed inside the TEE over sha-256 of the exact request and response bytes; we recompute both and recover the signer | `test_tampered_response_is_held`, `test_a_saved_reading_can_be_rechecked_offline` |
| D8 | A signer outside the attested enclave, or an old attestation report | Signer must be in a report fetched with our own fresh nonce | `test_a_signer_outside_the_attested_tee_is_held`, `test_a_stale_attestation_report_is_held` |
| D9 | The provider silently serves a different model | Exact model pinned, aliasing refused, served model name checked inside the signed bytes | `test_a_silently_swapped_model_is_held`; observed live on 1 Nov 2026 (proof log) |
| D10 | A cut-off answer is half-parsed | `finish_reason` must be `stop`, else HELD | `test_an_answer_cut_off_by_the_token_limit_is_held_not_parsed` |

## 2. The payee

| # | Threat | Defence | Proof |
|---|---|---|---|
| P1 | "New bank details" on a convincing invoice | The payee must equal the registered route; otherwise SEIZED | `attack_new_bank_details_on_a_signed_looking_invoice_is_seized` |
| P2 | Someone at the buyer is talked into updating the address | There is no "edit address". A change needs the **supplier's key** to propose it, the buyer to approve it, and 72 hours before it takes effect | `unapproved_change_never_takes_effect`, `attack_change_signed_by_the_wrong_key_is_rejected`, `approving_late_does_not_skip_the_wait_and_approving_early_does_not_shorten_it` |
| P3 | A signed change is replayed, re-pointed, or reused on another contract | Nonces, signature over the address, domain separation by contract | `attack_replaying_an_old_signed_change_is_rejected`, `attack_swapping_the_address_after_signing_is_rejected`, `attack_signature_made_for_another_contract_is_rejected` |
| P4 | An invoice is paid to another supplier's (legitimate) address | The payee must be **this** supplier's route, not any known address | `src/baseline_tests.rs` (row "another supplier's address") |
| P5 | A brand-new supplier is registered and paid at once | New suppliers wait 72 hours before they can be paid | `new_supplier_is_not_payable_for_72_hours` |
| P6 | The route changes between CLEARED and payment | Payment goes to the current route only; the old route is never paid | `if_the_route_changes_before_payment_the_old_one_is_not_paid` |
| P7 | Lookalike supplier IDs or invisible characters in addresses | Rejected at registration | `supplier_ids_with_lookalike_letters_are_rejected`, `addresses_with_invisible_characters_are_rejected` |

## 3. Billing and delivery

| # | Threat | Defence | Proof |
|---|---|---|---|
| B1 | Billing more than was delivered | Quantity per line must not exceed the signed delivery or the order | `billing_more_than_was_delivered_is_held` |
| B2 | Prices different from the order | HELD (`price_mismatch`) | `price_different_from_the_order_is_held` |
| B3 | One insider confirms a delivery that never happened | Two different roles must sign each delivery note (default policy: 2) | `one_signature_alone_is_held`, `property_a_delivery_needs_exactly_two_valid_roles` |
| B4 | The same signer counted twice, a removed signer, a re-registered key | Each key counts once, in one role, only while registered | `same_signer_twice_does_not_count_twice`, `a_removed_signer_no_longer_counts_even_for_signatures_made_before`, `a_re_registered_key_cannot_reuse_signatures_from_its_old_role` |
| B5 | The supplier signs its own delivery | Supplier and delivery-signer keys must differ, at registration and at submission | `the_suppliers_own_key_cannot_sign_the_delivery`, `attack_supplier_key_cannot_be_registered_as_a_storekeeper` |
| B6 | The same invoice, the same document, or the same delivery paid twice | Duplicates SEIZED by invoice number, document fingerprint and delivery note | `attack_paying_the_same_invoice_twice_is_seized`, `attack_renumbered_copy_of_a_paid_document_is_seized`, `attack_reusing_one_delivery_for_two_invoices_is_seized` |
| B7 | An invoice edited after the supplier signed it | Signature covers every field and the document fingerprint | `attack_invoice_edited_after_the_supplier_signed_it_is_seized`, `property_any_change_after_signing_is_never_cleared` |
| B8 | Splitting an invoice to dodge the per-invoice limit | Per-supplier period limit | `attack_splitting_invoices_to_dodge_the_limit_hits_the_period_limit` |
| B9 | Overflowing totals | Checked arithmetic, HELD | `attack_huge_quantities_cannot_overflow_the_total` |
| B10 | A forged copy blocks the real invoice | A seized forgery does not reserve the invoice number | `a_forged_copy_cannot_block_the_real_invoice` |

## 4. The agent's key

| # | Threat | Defence | Proof |
|---|---|---|---|
| K1 | The agent key is stolen and used to withdraw, change limits, or add signers | NEAR function-call key: two methods only, no deposits; every owner method needs 1 yoctoNEAR | refusals on testnet, `docs/testnet-proof.md`; `scripts/attack-demo.sh --onchain` |
| K2 | The key moves USDC directly | USDC's `ft_transfer` needs 1 yoctoNEAR; the key cannot attach it, and only works on the guard contract | proof log (refused by NEAR) |
| K3 | The key floods the contract with submissions | Daily submission limit (1–1000), storage-money check | `agent_cannot_exhaust_contract_storage_beyond_the_daily_limit`, `submissions_stop_before_the_contract_runs_out_of_storage_money` |
| K4 | Strangers submit, pay, or fake a payout result | Caller checks; callbacks only from the contract itself | `strangers_cannot_submit_invoices`, `strangers_cannot_fake_a_payout_callback`, `attack_direct_call_with_the_contracts_own_key_cannot_fake_a_payout_result` |

## 5. Payments

| # | Threat | Defence | Proof |
|---|---|---|---|
| M1 | Paying twice | Fixed payment states; a settled payment can never be paid again | `a_settled_payment_can_never_be_paid_again`, `a_callback_cannot_settle_the_same_payment_twice` |
| M2 | A lost or late transfer result is misread | Unknown outcomes are never treated as failure; resolved from the balance only when unambiguous | `attack_unknown_outcome_is_never_treated_as_failure`, `with_two_payouts_in_flight_a_lower_balance_proves_nothing`, `attack_stale_payout_result_from_an_earlier_attempt_cannot_touch_the_current_one` |
| M3 | The operator drains reserved money | `withdraw` pays the owner only, never reserved funds | `withdraw_cannot_take_reserved_money`, `property_random_action_sequences_keep_every_money_rule` |
| M4 | Returned tokens are used to pay twice | A repeat payout can only be funded by the returned tokens | `attack_returned_tokens_can_fund_a_repeat_payout_but_never_the_buyers_money` |

## 6. Compared with the usual guard

An allowlist plus spending limits stops a brand-new attacker address and oversized payments. On
the other nine invoice attacks in `src/baseline_tests.rs` it pays; Clear to Pay pays none. Table:
[docs/baseline.md](docs/baseline.md), regenerated by `scripts/baseline.sh`.

## 7. Not defended (yet), stated

- **The first address check.** The first registration of a supplier's address relies on the buyer checking it out of band. Planned: proof of control at registration (the payout account signs first).
- **Two colluding insiders.** If two people in different roles both sign a false delivery, it clears. The policy can require more roles; it cannot stop collusion.
- **The attestation report down to the hardware.** We check the signer is in a fresh report and keep the whole report, but do not yet verify the Intel TDX quote and NVIDIA evidence ourselves (NEAR's `nearai-cloud-verifier` can).
- **Rendering tricks the reader does not see yet:** clipping paths, transparency, text over photographs. Backstop: the payee rule.
- **The contract account's full-access key** can deploy new code. Disclosed; planned to be deleted at the end ("final lock").
- **Not audited.** Hackathon code, testnet and small mainnet amounts only.
