# Threat model

What Clear to Pay defends against, how, and where each defence is proven. Every test named
here runs with `cargo test` (contract, `src/`) or `python3 -m pytest -q` (reader, `reader/tests/`).
Gaps are listed at the end, not hidden.

**What we protect:** the buyer's money in the contract pool. **The rule:** money leaves only to a
supplier's registered address, for goods that two registered keys in two different roles signed
as delivered (two by default; keys are not identities), at the order's prices, once.

**Who might attack:** an outsider who controls an email thread or a PDF; a prompt injection that
fools the AI; a thief who steals the agent's key; a dishonest supplier; one dishonest insider at
the buyer (a storekeeper, say); a cloud AI provider that swaps or tampers with the model.

## 1. The document and the AI

- **D1. Hidden text in the PDF ("bank details changed, pay X") reaches the model.** Only glyphs a person can see are kept; hidden text that mentions payment HOLDS the invoice before any model call. *Proof:* 19-invoice corpus, `reader/corpus/expected.json`; `reader/tests/test_reader.py`.
- **D2. Invisible characters, right-to-left overrides, lookalike letters in identifiers.** Unicode clean-up; zero-width, bidi and mixed-script tokens HOLD. *Proof:* corpus cases 07, 08, 09.
- **D3. A scanned page whose text layer says something else.** Scans are HELD (`scanned_document`). *Proof:* corpus cases 13, 15.
- **D4. A malicious PDF attacks the parser (decompression bomb, probes).** Parsed in a child with no network, no environment, memory, CPU, time and output limits; any failure HOLDS. *Proof:* `reader/ctp_reader/isolated.py`; isolation tests in `test_reader.py`.
- **D5. The model is fooled anyway and writes the attacker's address.** The model's answer has **no payee field**; the payee always comes from the supplier's registered record. *Proof:* `test_a_well_formed_answer_becomes_exactly_the_invoice_the_supplier_signs`; contract `attack_ai_fooled_into_writing_the_attackers_address_is_seized`.
- **D6. The model answers with extra fields, prose, or numbers that do not add up.** Strict schema: unknown, missing or malformed fields rejected, never repaired; totals and amount-in-words checked. *Proof:* `reader/tests/test_reader.py`; `test_a_signed_answer_that_does_not_add_up_is_held`.
- **D7. The AI provider tampers with an answer.** The answer is signed inside the TEE over sha-256 of the exact request and response bytes; we recompute both and recover the signer. *Proof:* `test_tampered_response_is_held`, `test_a_saved_reading_can_be_rechecked_offline`.
- **D8. A signer outside the attested enclave, an old or nonce-less report, a quote for another key, or another model.** The report part must carry our fresh nonce exactly, its Intel TDX quote must hold the signer's address and our nonce in REPORTDATA, and a model part must name the pinned model; unknown signature kinds are refused. *Proof:* `test_a_signer_outside_the_attested_tee_is_held`, `test_a_stale_attestation_report_is_held`, `test_a_report_without_our_nonce_is_held`, `test_a_quote_that_does_not_bind_the_signer_and_our_nonce_is_held`, `test_an_attestation_for_another_model_does_not_count`, `test_an_unknown_signature_kind_is_refused`.
- **D8b. A saved (cached) answer is planted or edited on disk.** Every cached answer is re-verified in full before use; cache files are private, written atomically, never followed through links. *Proof:* `test_a_tampered_cached_answer_is_rechecked_and_held`, `test_a_cache_file_that_is_a_link_is_not_followed`, `test_cache_files_are_private`.
- **D8c. A fabricated report: an invented quote naming the attacker's key, or an emulated GPU.** `--hardware`: the TDX quote's signature chain must verify to Intel's root CA (dcap-qvl, Intel PCS collateral) and its verified REPORTDATA must hold the enclave's address and our nonce; the GPU evidence must carry our nonce and NVIDIA's attestation service must answer true. *Proof:* `test_a_quote_that_does_not_verify_fails`, `test_a_quote_whose_verified_report_data_differs_fails`, `test_gpu_evidence_must_carry_our_nonce_and_nvidia_must_say_true`, `test_a_revoked_platform_fails_and_out_of_date_is_recorded_not_hidden`.
- **D8d. A supply-chain swap: a genuine enclave running other software or another model.** The event log must replay to the quote's RTMR3 (OS image and container setup measured), and the compose manager's launch log, signed in its own quote from the same machine with our nonce, must show the pinned model's container launched by a pinned deployment file (sha256, tag, commit). Fingerprints live in `reader/software-pins.json`; anything else is HELD until pinned on purpose. The weights' own hash is not checked (see "Not defended"). *Proof:* `test_a_changed_container_setup_is_caught`, `test_an_edited_event_log_does_not_replay`, `test_an_edited_launch_log_or_another_nonce_is_caught`, `test_unpinned_software_is_held_and_pinning_is_explicit`, `test_the_read_flow_holds_an_answer_from_unpinned_software`.
- **D8e. A deprecation forces a re-pin, and the replacement reads worse.** Pinning only helps while the pinned version exists; when NEAR retires it, answers are HELD (`model_software_unpinned`) until someone re-pins. A re-pin is a reviewed commit to `software-pins.json`, and `--pin-software` refuses software that is not covered by a passing qualification report for that model and prompt version: seven fictional invoices through the full verified call (exact reads, a thousands separator, an amount in words that must be HELD when it disagrees, a total and a payee written into the invoice as instructions). Seven cases are a gate, not a measure of accuracy; the supplier's signature over the invoice digest stays the backstop. *Proof:* `test_a_model_that_obeys_the_invoice_does_not_qualify`, `test_a_model_that_skips_the_amount_in_words_does_not_qualify`, `test_right_answers_signed_outside_the_attested_enclave_do_not_qualify`, `test_pinning_needs_a_passing_report_that_covers_the_software`.
- **D9. The provider silently serves a different model.** Exact model pinned, aliasing refused, served model name checked inside the signed bytes. *Proof:* `test_a_silently_swapped_model_is_held`; observed live on 1 Nov 2026 (proof log).
- **D10. A cut-off answer is half-parsed.** `finish_reason` must be `stop`, else HELD. *Proof:* `test_an_answer_cut_off_by_the_token_limit_is_held_not_parsed`.
- **D11. The AI's follow-up email slips in a payment instruction, a promise or a made-up figure, or is drafted from the wrong files.** The files must reproduce the receipt's fingerprints; the draft may not add numbers, dates, numbers in words, promises, contact routes, addresses, links, wallets, bank words, non-ASCII digits or invisible characters; address-like facts mean no draft; SEIZED gets no reply. A strict filter, not proof of meaning: a person reads every draft. *Proof:* `test_another_invoice_with_the_same_number_is_refused`, `test_promises_dates_and_numbers_in_words_are_refused`, `test_an_address_smuggled_in_as_a_sku_means_no_draft_at_all`, `test_seized_gets_no_supplier_draft_and_says_do_not_reply`.

## 2. The payee

- **P1. "New bank details" on a convincing invoice.** The payee must equal the registered route; otherwise SEIZED. *Proof:* `attack_new_bank_details_on_a_signed_looking_invoice_is_seized`.
- **P2. Someone at the buyer is talked into updating the address.** There is no "edit address". A change needs the **supplier's key** to propose it, the buyer to approve it, and 72 hours before it takes effect. *Proof:* `unapproved_change_never_takes_effect`, `attack_change_signed_by_the_wrong_key_is_rejected`, `approving_late_does_not_skip_the_wait_and_approving_early_does_not_shorten_it`.
- **P3. A signed change is replayed, re-pointed, or reused on another contract.** Nonces, signature over the address, domain separation by contract. *Proof:* `attack_replaying_an_old_signed_change_is_rejected`, `attack_swapping_the_address_after_signing_is_rejected`, `attack_signature_made_for_another_contract_is_rejected`.
- **P4. An invoice is paid to another supplier's (legitimate) address.** The payee must be **this** supplier's route, not any known address. *Proof:* `src/baseline_tests.rs` (row "another supplier's address").
- **P5. A brand-new supplier is registered and paid at once.** New suppliers wait 72 hours before they can be paid. *Proof:* `new_supplier_is_not_payable_for_72_hours`.
- **P6. The route changes between CLEARED and payment.** Payment goes to the current route only; the old route is never paid. *Proof:* `if_the_route_changes_before_payment_the_old_one_is_not_paid`.
- **P7. Lookalike supplier IDs or invisible characters in addresses.** Rejected at registration. *Proof:* `supplier_ids_with_lookalike_letters_are_rejected`, `addresses_with_invisible_characters_are_rejected`.
- **P8. An address change, a new supplier or a new delivery signer slips through because nobody looks during the 72-hour wait.** Alerts every 15 s over every supplier the contract lists; the signed-change counter catches a change proposed and cancelled between checks; damaged memory and RPC disagreement are ALERTs. *Proof:* `test_a_proposed_address_change_is_an_alarm_with_the_earliest_payable_time`, `test_a_change_proposed_and_cancelled_between_checks_is_still_an_alarm`, `test_a_supplier_added_later_is_watched_without_editing_any_list`, `test_an_added_delivery_signer_is_an_alarm`, `test_rpc_servers_that_disagree_about_an_address_raise_an_alarm`.

## 3. Billing and delivery

- **B1. Billing more than was delivered.** Quantity per line must not exceed the signed delivery or the order. *Proof:* `billing_more_than_was_delivered_is_held`.
- **B2. Prices different from the order.** HELD (`price_mismatch`). *Proof:* `price_different_from_the_order_is_held`.
- **B3. One insider confirms a delivery that never happened.** Two different roles must sign each delivery note (default policy: 2). *Proof:* `one_signature_alone_is_held`, `property_a_delivery_needs_exactly_two_valid_roles`.
- **B4. The same signer counted twice, a removed signer, a re-registered key.** Each key counts once, in one role, only while registered. *Proof:* `same_signer_twice_does_not_count_twice`, `a_removed_signer_no_longer_counts_even_for_signatures_made_before`, `a_re_registered_key_cannot_reuse_signatures_from_its_old_role`.
- **B5. The supplier signs its own delivery.** Supplier and delivery-signer keys must differ, at registration and at submission. *Proof:* `the_suppliers_own_key_cannot_sign_the_delivery`, `attack_supplier_key_cannot_be_registered_as_a_storekeeper`.
- **B6. The same invoice, the same document, or the same delivery paid twice.** Duplicates SEIZED by invoice number, document fingerprint and delivery note. *Proof:* `attack_paying_the_same_invoice_twice_is_seized`, `attack_renumbered_copy_of_a_paid_document_is_seized`, `attack_reusing_one_delivery_for_two_invoices_is_seized`.
- **B7. An invoice edited after the supplier signed it.** Signature covers every field and the document fingerprint. *Proof:* `attack_invoice_edited_after_the_supplier_signed_it_is_seized`, `property_any_change_after_signing_is_never_cleared`.
- **B8. Splitting an invoice to dodge the per-invoice limit.** Per-supplier period limit. *Proof:* `attack_splitting_invoices_to_dodge_the_limit_hits_the_period_limit`.
- **B9. Overflowing totals.** Checked arithmetic, HELD. *Proof:* `attack_huge_quantities_cannot_overflow_the_total`.
- **B10. A forged copy blocks the real invoice.** A seized forgery does not reserve the invoice number. *Proof:* `a_forged_copy_cannot_block_the_real_invoice`.

## 4. The agent's key

- **K1. The agent key is stolen and used to withdraw, change limits, or add signers.** NEAR function-call key: two methods only, no deposits; every owner method needs 1 yoctoNEAR. *Proof:* refusals on testnet, `docs/testnet-proof.md`; `scripts/attack-demo.sh --onchain`.
- **K2. The key moves USDC directly.** USDC's `ft_transfer` needs 1 yoctoNEAR; the key cannot attach it, and only works on the guard contract. *Proof:* proof log (refused by NEAR).
- **K3. The key floods the contract with submissions.** Daily submission limit (1–1000), storage-money check. *Proof:* `agent_cannot_exhaust_contract_storage_beyond_the_daily_limit`, `submissions_stop_before_the_contract_runs_out_of_storage_money`.
- **K4. Strangers submit, pay, or fake a payout result.** Caller checks; callbacks only from the contract itself. *Proof:* `strangers_cannot_submit_invoices`, `strangers_cannot_fake_a_payout_callback`, `attack_direct_call_with_the_contracts_own_key_cannot_fake_a_payout_result`.

## 5. Payments

- **M1. Paying twice.** Fixed payment states; a settled payment can never be paid again. *Proof:* `a_settled_payment_can_never_be_paid_again`, `a_callback_cannot_settle_the_same_payment_twice`.
- **M2. A lost or late transfer result is misread.** Unknown outcomes are never treated as failure; resolved from the balance only when unambiguous. *Proof:* `attack_unknown_outcome_is_never_treated_as_failure`, `with_two_payouts_in_flight_a_lower_balance_proves_nothing`, `attack_stale_payout_result_from_an_earlier_attempt_cannot_touch_the_current_one`.
- **M2b. A payout that really left is stuck for ever because its in-flight counter was lost.** If the counter is missing, the balance settles it only when this payment is the only money reserved; otherwise it stays unresolved and visible (`payment_unresolved`). *Proof:* `a_paid_transfer_with_a_missing_counter_settles_when_it_is_the_only_reserved_payment`, `a_missing_counter_with_another_reserved_payment_stays_unresolved`.
- **M3. The operator drains reserved money.** `withdraw` pays the owner only, never reserved funds. *Proof:* `withdraw_cannot_take_reserved_money`, `property_random_action_sequences_keep_every_money_rule`.
- **M4. Returned tokens are used to pay twice.** A repeat payout can only be funded by the returned tokens. *Proof:* `attack_returned_tokens_can_fund_a_repeat_payout_but_never_the_buyers_money`.

## 6. Compared with the usual guard

A global allowlist plus limits stops a brand-new attacker address and oversized payments, and pays
the other 9 of the 11 invoice attacks in `src/baseline_tests.rs`. A per-supplier allowlist also stops
paying one supplier's invoice to another's address, and pays 8 of 11. Clear to Pay pays none, and all
three pay the honest invoice. Table: [docs/baseline.md](docs/baseline.md), regenerated by `scripts/baseline.sh`.

## 7. Not defended (yet), stated

- **The first address check.** The first registration of a supplier's address relies on the buyer checking it out of band. Planned: proof of control at registration (the payout account signs first).
- **Two colluding insiders.** If two people in different roles both sign a false delivery, it clears. The policy can require more roles; it cannot stop collusion.
- **Model weights.** We pin the deployment that launched the model, not a hash of the weights; they are only as provable as NEAR's pinned deployment file and downloader. A misread invoice still fails the supplier's signature.
- **The hardware check is on demand.** `--hardware` verifies the Intel quote chain and NVIDIA's verdict, but it is not run on every invoice by default (it needs Intel's and NVIDIA's services). An invoice read without it is protected by the signature and REPORTDATA checks only; a compromised gateway able to fabricate a whole report, quote included, would be caught only by `--hardware`.
- **Keys are not people.** The delivery rule counts distinct registered keys in distinct roles. One person holding two keys, or two colluding people, defeats it; the owner can also set a policy of one role (recorded and versioned).
- **Alerts between checks.** A delivery signer added and removed within one 15-second interval is not seen (anything it signed would be, as a receipt).
- **Rendering tricks the reader does not see yet:** clipping paths, transparency, text over photographs. Backstop: the payee rule.
- **The contract account's full-access key** can deploy new code. Disclosed; planned to be deleted at the end ("final lock").
- **Not audited.** Hackathon code, testnet and small mainnet amounts only.
