//! Tests for the findings of the 30 Oct 2026 adversarial audit. Each test is
//! named after the attack or failure it rules out.

use super::inspection::*;
use super::payments::*;
use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{
    NearToken, PromiseOrValue, PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env,
};

const HOUR: u64 = 3_600_000_000_000;
const DAY: u64 = 24 * HOUR;
const T0: u64 = 1_800_000_000 * 1_000_000_000;
const LIVE: u64 = T0 + 100 * HOUR;
const UNIT: u128 = 1_000_000;
const SUPPLIER: u8 = 7;
const STOREKEEPER: u8 = 21;

fn owner() -> AccountId {
    "buyer.testnet".parse().unwrap()
}
fn usdc() -> AccountId {
    "usdc.testnet".parse().unwrap()
}
fn contract_id() -> AccountId {
    "cleartopay.testnet".parse().unwrap()
}
fn builder(caller: AccountId, at: u64, yocto: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(caller.clone())
        .signer_account_id(caller)
        .block_timestamp(at)
        .attached_deposit(NearToken::from_yoctonear(yocto));
    b
}
fn ctx(caller: AccountId, at: u64, yocto: u128) {
    testing_env!(builder(caller, at, yocto).build());
}
fn callback_ctx(at: u64, result: PromiseResult) {
    testing_env!(
        builder(contract_id(), at, 0).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}
fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}
fn pk(k: &SigningKey) -> PublicKey {
    let mut b = vec![0u8];
    b.extend_from_slice(k.verifying_key().as_bytes());
    PublicKey::try_from(b).unwrap()
}
fn route(addr: &str) -> PayoutRoute {
    PayoutRoute {
        chain: "near".into(),
        token: "usdc.testnet".into(),
        address: addr.into(),
    }
}

fn setup() -> Contract {
    ctx(owner(), T0, 0);
    let mut c = Contract::new(owner());
    ctx(owner(), T0, 1);
    c.register_supplier(
        "qingmar-steel".into(),
        pk(&key(SUPPLIER)),
        route("qingmar.testnet"),
    );
    ctx(owner(), T0, 1);
    c.add_storekeeper(pk(&key(STOREKEEPER)));
    ctx(owner(), T0, 1);
    c.add_delivery_signer(
        crate::test_support::pubkey(crate::test_support::WEIGHBRIDGE_SEED),
        "weighbridge".into(),
    );
    ctx(owner(), T0, 1);
    c.create_order(
        "PO-1184".into(),
        "qingmar-steel".into(),
        "usdc.testnet".into(),
        vec![OrderLine {
            sku: "AH36-12mm".into(),
            qty: U64(1000),
            unit_price: U128(780 * UNIT),
        }],
    );
    ctx(owner(), T0, 1);
    c.set_limits(U128(100_000 * UNIT), U128(1_000_000 * UNIT), U64(720), 100);
    ctx(owner(), T0, 1);
    c.allow_token(usdc());
    c
}

fn deposit(c: &mut Contract, amount: u128) {
    ctx(usdc(), LIVE, 0);
    match c.ft_on_transfer(owner(), U128(amount), String::new()) {
        PromiseOrValue::Value(v) => assert_eq!(v, U128(0)),
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

/// Submit an invoice. `signer` signs the invoice; `signed_doc` is the fingerprint
/// it signs; `submitted_doc` is the fingerprint sent to the contract.
#[allow(clippy::too_many_arguments)]
fn submit_with(
    c: &mut Contract,
    number: &str,
    qty: u64,
    payee: &str,
    signer: u8,
    signed_doc: u8,
    submitted_doc: u8,
    at: u64,
) -> InspectionResult {
    let inv = Invoice {
        supplier_id: "qingmar-steel".into(),
        invoice_number: number.into(),
        order_id: "PO-1184".into(),
        token: "usdc.testnet".into(),
        lines: vec![InvoiceLine {
            sku: "AH36-12mm".into(),
            qty: U64(qty),
            unit_price: U128(780 * UNIT),
        }],
        total: U128(qty as u128 * 780 * UNIT),
        payee: route(payee),
    };
    let note = DeliveryNote {
        order_id: "PO-1184".into(),
        note_id: format!("DN-{number}"),
        lines: vec![DeliveredLine {
            sku: "AH36-12mm".into(),
            qty: U64(qty),
        }],
    };
    let d1 = InvoiceMessage {
        domain: INVOICE_DOMAIN.into(),
        contract: contract_id(),
        invoice: inv.clone(),
        document_hash: [signed_doc; 32],
    }
    .digest();
    let sigs = crate::test_support::two_signatures(&note, &contract_id());
    ctx(owner(), at, 0);
    c.submit_invoice(
        inv,
        Base64VecU8(key(signer).sign(&d1).to_bytes().to_vec()),
        note,
        sigs,
        Base64VecU8(vec![submitted_doc; 32]),
    )
}
fn honest(c: &mut Contract, number: &str, qty: u64, doc: u8, at: u64) -> InspectionResult {
    submit_with(c, number, qty, "qingmar.testnet", SUPPLIER, doc, doc, at)
}
fn has(r: &InspectionResult, code: &str) -> bool {
    r.reasons.iter().any(|x| x == code)
}

// ------------------------------------------------- finding 1: document fingerprint

#[test]
fn attack_forged_invoice_cannot_poison_legitimate_document_hash() {
    let mut c = setup();
    // A hijacked agent submits a forgery carrying the REAL document's fingerprint (5).
    let forged = submit_with(&mut c, "INV-2208", 10, "attacker.testnet", 66, 5, 5, LIVE);
    assert_eq!(forged.verdict, Verdict::Seized);
    // The real supplier's invoice with that same document still clears.
    let real = honest(&mut c, "INV-2208", 10, 5, LIVE);
    assert_eq!(
        real.verdict,
        Verdict::Cleared,
        "reasons: {:?}",
        real.reasons
    );
}

#[test]
fn attack_document_fingerprint_swapped_after_signing_is_seized() {
    let mut c = setup();
    // The supplier signed fingerprint 1; the agent submits fingerprint 2.
    let r = submit_with(&mut c, "INV-1", 10, "qingmar.testnet", SUPPLIER, 1, 2, LIVE);
    assert_eq!(r.verdict, Verdict::Seized);
    assert!(has(&r, "invalid_supplier_signature"));
}

#[test]
fn an_authenticated_seized_document_stays_seized() {
    let mut c = setup();
    // The real supplier's key signed it, but it asks to be paid elsewhere: seized,
    // and this authenticated document is remembered.
    let first = submit_with(
        &mut c,
        "INV-9",
        10,
        "elsewhere.testnet",
        SUPPLIER,
        4,
        4,
        LIVE,
    );
    assert_eq!(first.verdict, Verdict::Seized);
    let again = honest(&mut c, "INV-9b", 10, 4, LIVE);
    assert_eq!(again.verdict, Verdict::Seized);
    assert!(has(&again, "duplicate_document"));
}

// ------------------------------------------------- finding 2: role separation

#[test]
#[should_panic(expected = "supplier and storekeeper keys must differ")]
fn attack_supplier_key_cannot_be_registered_as_a_storekeeper() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.add_storekeeper(pk(&key(SUPPLIER)));
}

#[test]
#[should_panic(expected = "supplier and storekeeper keys must differ")]
fn attack_storekeeper_key_cannot_be_registered_as_a_supplier() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.register_supplier(
        "other-co".into(),
        pk(&key(STOREKEEPER)),
        route("other.testnet"),
    );
}

#[test]
#[should_panic(expected = "this key already belongs to another supplier")]
fn two_suppliers_cannot_share_a_signing_key() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.register_supplier(
        "qingmar-copy".into(),
        pk(&key(SUPPLIER)),
        route("copy.testnet"),
    );
}

// ------------------------------------------------- finding 5: storage exhaustion

#[test]
fn agent_cannot_exhaust_contract_storage_beyond_the_daily_limit() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.set_limits(U128(100_000 * UNIT), U128(1_000_000 * UNIT), U64(720), 3);
    for i in 0..3u8 {
        honest(&mut c, &format!("INV-{i}"), 1, 10 + i, LIVE);
    }
    let fourth = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        honest(&mut c, "INV-4", 1, 20, LIVE)
    }));
    assert!(
        fourth.is_err(),
        "the 4th submission of the day must be refused"
    );
    assert_eq!(c.receipt_count(), 3);
    // A new UTC day resets the count.
    let next_day = honest(&mut c, "INV-5", 1, 21, LIVE + DAY);
    assert_eq!(next_day.verdict, Verdict::Cleared);
}

#[test]
#[should_panic(expected = "daily submission limit must be 1 to 1000")]
fn the_daily_limit_cannot_be_switched_off() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.set_limits(U128(1), U128(1), U64(24), 0);
}

// ------------------------------------------------- finding 7: documented semantics

#[test]
fn period_limit_uses_fixed_windows_as_documented() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    // 1-hour windows, cap 10 t worth per window.
    c.set_limits(U128(7_800 * UNIT), U128(7_800 * UNIT), U64(1), 100);
    let window = HOUR;
    let end_of_window = (LIVE / window + 1) * window - 1;
    let a = honest(&mut c, "INV-A", 10, 30, end_of_window);
    let b = honest(&mut c, "INV-B", 10, 31, end_of_window + 1);
    // Fixed windows: both clear, one nanosecond apart. This is the documented behaviour.
    assert_eq!((a.verdict, b.verdict), (Verdict::Cleared, Verdict::Cleared));
}

// ------------------------------------------------- findings 3 and 4: payment recovery

#[test]
fn failed_payment_can_be_reauthorized_and_is_sent_once() {
    let mut c = setup();
    deposit(&mut c, 100_000 * UNIT);
    let r = honest(&mut c, "INV-1", 100, 1, LIVE);
    assert_eq!(r.payment, Some(PaymentStatus::Submitted));
    callback_ctx(LIVE, PromiseResult::Failed);
    assert_eq!(c.on_payout(r.receipt_id, 1), PaymentStatus::Failed);
    assert_eq!(c.get_funds(usdc()).reserved, U128(0));

    ctx(owner(), LIVE + HOUR, 1);
    assert_eq!(
        c.reauthorize_payment(r.receipt_id),
        PaymentStatus::Submitted
    );
    let p = c.get_payment(r.receipt_id).unwrap();
    assert_eq!(p.attempt, 2);
    let f = c.get_funds(usdc());
    assert_eq!(
        (f.available, f.reserved),
        (U128(22_000 * UNIT), U128(78_000 * UNIT))
    );
}

#[test]
fn expired_payment_requires_explicit_reauthorization() {
    let mut c = setup();
    let r = honest(&mut c, "INV-1", 10, 1, LIVE); // no funds: waits as AUTHORIZED
    deposit(&mut c, 100_000 * UNIT);
    ctx(owner(), LIVE + 8 * DAY, 0);
    assert_eq!(c.execute_payment(r.receipt_id), PaymentStatus::Expired);
    ctx(owner(), LIVE + 8 * DAY, 1);
    assert_eq!(
        c.reauthorize_payment(r.receipt_id),
        PaymentStatus::Submitted
    );
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn cancelled_payment_cannot_be_reopened_without_buyer_approval() {
    let mut c = setup();
    let r = honest(&mut c, "INV-1", 10, 1, LIVE);
    ctx(owner(), LIVE, 1);
    c.cancel_payment(r.receipt_id);
    ctx("stranger.testnet".parse().unwrap(), LIVE, 1);
    c.reauthorize_payment(r.receipt_id);
}

#[test]
#[should_panic(expected = "only failed, expired or cancelled payments can be reauthorised")]
fn a_settled_payment_can_never_be_reauthorized() {
    let mut c = setup();
    deposit(&mut c, 100_000 * UNIT);
    let r = honest(&mut c, "INV-1", 10, 1, LIVE);
    callback_ctx(LIVE, PromiseResult::Successful(vec![]));
    c.on_payout(r.receipt_id, 1);
    ctx(owner(), LIVE, 1);
    c.reauthorize_payment(r.receipt_id);
}

#[test]
fn reauthorized_payment_goes_to_the_current_route_after_an_approved_change() {
    let mut c = setup();
    let r = honest(&mut c, "INV-1", 10, 1, LIVE);
    ctx(owner(), LIVE, 1);
    c.cancel_payment(r.receipt_id);
    // The supplier moves to a new address: signed, approved, 72 hours.
    let new = route("qingmar-new.testnet");
    let d = PayoutChangeMessage {
        domain: PAYOUT_CHANGE_DOMAIN.into(),
        contract: contract_id(),
        supplier_id: "qingmar-steel".into(),
        nonce: 1,
        route: new.clone(),
    }
    .digest();
    ctx(owner(), LIVE, 0);
    c.propose_payout_change(
        "qingmar-steel".into(),
        new.clone(),
        U64(1),
        Base64VecU8(key(SUPPLIER).sign(&d).to_bytes().to_vec()),
    );
    ctx(owner(), LIVE, 1);
    c.approve_payout_change("qingmar-steel".into());
    ctx(owner(), LIVE + 73 * HOUR, 1);
    c.reauthorize_payment(r.receipt_id);
    assert_eq!(c.get_payment(r.receipt_id).unwrap().recipient, new);
}

#[test]
#[should_panic(expected = "callbacks must follow a transfer")]
fn attack_direct_call_with_the_contracts_own_key_cannot_fake_a_payout_result() {
    let mut c = setup();
    deposit(&mut c, 100_000 * UNIT);
    let r = honest(&mut c, "INV-1", 10, 1, LIVE);
    // Signed by the contract account itself, but not following any transfer.
    ctx(contract_id(), LIVE, 0);
    c.on_payout(r.receipt_id, 1);
}

// ------------------------------------------------------------------ second audit (31 Oct)

fn balance_result(units: u128) -> PromiseResult {
    PromiseResult::Successful(format!("\"{units}\"").into_bytes())
}

/// A cleared 7.8 USDC payment sent from a 100,000 USDC pool, its callback lost.
fn stuck() -> (Contract, u32) {
    let mut c = setup();
    deposit(&mut c, 100_000 * UNIT);
    let r = honest(&mut c, "INV-1", 10, 1, LIVE);
    assert_eq!(r.payment, Some(PaymentStatus::Submitted));
    (c, r.receipt_id)
}

#[test]
#[should_panic(expected = "a submitted payment can only be resolved 24 hours after it was sent")]
fn stuck_payment_cannot_be_resolved_early() {
    let (mut c, id) = stuck();
    ctx(owner(), LIVE + 23 * HOUR, 1);
    let _ = c.resolve_stuck_payment(id);
}

#[test]
fn resolution_reads_the_balance_and_refunds_only_if_the_money_never_left() {
    let (mut c, id) = stuck();
    ctx(owner(), LIVE + DAY, 1);
    let _ = c.resolve_stuck_payment(id);
    // The token says we still hold everything: the transfer never happened.
    callback_ctx(LIVE + DAY, balance_result(100_000 * UNIT));
    assert_eq!(c.on_balance_checked(id, 1), PaymentStatus::Failed);
    let f = c.get_funds(usdc());
    assert_eq!((f.available, f.reserved), (U128(100_000 * UNIT), U128(0)));
    assert_eq!(c.get_in_flight(usdc()).payouts, 0);
    // A late result for the same attempt cannot move the money again.
    callback_ctx(LIVE + DAY, PromiseResult::Successful(vec![]));
    let late = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.on_payout(id, 1)));
    assert!(late.is_err());
}

#[test]
fn resolution_settles_when_the_balance_shows_the_money_left() {
    let (mut c, id) = stuck();
    ctx(owner(), LIVE + DAY, 1);
    let _ = c.resolve_stuck_payment(id);
    callback_ctx(LIVE + DAY, balance_result(100_000 * UNIT - 7_800 * UNIT));
    assert_eq!(c.on_balance_checked(id, 1), PaymentStatus::Settled);
    let f = c.get_funds(usdc());
    assert_eq!(
        (f.available, f.reserved),
        (U128(100_000 * UNIT - 7_800 * UNIT), U128(0))
    );
}

#[test]
fn attack_unknown_outcome_is_never_treated_as_failure() {
    // Each case in a fresh thread: a fresh mock chain.
    let cases: Vec<Option<u128>> = vec![
        Some(100_000 * UNIT + 1), // someone sent us extra tokens
        Some(100_000 * UNIT - 1), // a balance neither outcome explains
        Some(0),
        None, // the balance query itself failed
    ];
    for case in cases {
        std::thread::spawn(move || {
            let (mut c, id) = stuck();
            ctx(owner(), LIVE + DAY, 1);
            let _ = c.resolve_stuck_payment(id);
            let result = match case {
                Some(units) => balance_result(units),
                None => PromiseResult::Failed,
            };
            callback_ctx(LIVE + DAY, result);
            assert_eq!(c.on_balance_checked(id, 1), PaymentStatus::Submitted);
            assert_eq!(
                c.get_funds(usdc()).reserved,
                U128(7_800 * UNIT),
                "money must stay reserved"
            );
            assert!(get_logs().iter().any(|l| l.contains("payment_unresolved")));
        })
        .join()
        .expect("case passed");
    }
}

#[test]
fn with_two_payouts_in_flight_a_lower_balance_proves_nothing() {
    let mut c = setup();
    deposit(&mut c, 100_000 * UNIT);
    let a = honest(&mut c, "INV-1", 10, 1, LIVE).receipt_id;
    honest(&mut c, "INV-2", 10, 2, LIVE);
    assert_eq!(c.get_in_flight(usdc()).payouts, 2);
    ctx(owner(), LIVE + DAY, 1);
    let _ = c.resolve_stuck_payment(a);
    // One of the two transfers left; the balance alone cannot say which.
    callback_ctx(LIVE + DAY, balance_result(100_000 * UNIT - 7_800 * UNIT));
    assert_eq!(c.on_balance_checked(a, 1), PaymentStatus::Submitted);
}

#[test]
#[should_panic(expected = "a withdrawal is in flight")]
fn resolution_waits_for_withdrawals_in_flight() {
    let (mut c, id) = stuck();
    ctx(owner(), LIVE + DAY, 1);
    let _ = c.withdraw(usdc(), U128(UNIT));
    ctx(owner(), LIVE + DAY, 1);
    let _ = c.resolve_stuck_payment(id);
}

#[test]
fn attack_stale_payout_result_from_an_earlier_attempt_cannot_touch_the_current_one() {
    let (mut c, id) = stuck();
    callback_ctx(LIVE, PromiseResult::Failed);
    assert_eq!(c.on_payout(id, 1), PaymentStatus::Failed);
    ctx(owner(), LIVE + HOUR, 1);
    assert_eq!(c.reauthorize_payment(id), PaymentStatus::Submitted);
    assert_eq!(c.get_payment(id).unwrap().attempt, 2);
    // A (replayed or delayed) result tagged with attempt 1 is refused.
    callback_ctx(LIVE + HOUR, PromiseResult::Successful(vec![]));
    let stale = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.on_payout(id, 1)));
    assert!(stale.is_err());
    assert_eq!(c.get_payment(id).unwrap().status, PaymentStatus::Submitted);
    // The real result for attempt 2 settles it, once.
    callback_ctx(LIVE + HOUR, PromiseResult::Successful(vec![]));
    assert_eq!(c.on_payout(id, 2), PaymentStatus::Settled);
}

#[test]
fn a_balance_check_that_arrives_after_the_real_result_changes_nothing() {
    let (mut c, id) = stuck();
    ctx(owner(), LIVE + DAY, 1);
    let _ = c.resolve_stuck_payment(id);
    callback_ctx(LIVE + DAY, PromiseResult::Successful(vec![]));
    assert_eq!(c.on_payout(id, 1), PaymentStatus::Settled);
    callback_ctx(LIVE + DAY, balance_result(100_000 * UNIT));
    assert_eq!(c.on_balance_checked(id, 1), PaymentStatus::Settled);
    assert_eq!(
        c.get_funds(usdc()).available,
        U128(100_000 * UNIT - 7_800 * UNIT)
    );
}

#[test]
#[should_panic(expected = "only a submitted payment can be resolved")]
fn only_submitted_payments_can_be_resolved() {
    let mut c = setup();
    let r = honest(&mut c, "INV-1", 10, 1, LIVE); // no funds: AUTHORIZED
    ctx(owner(), LIVE + 2 * DAY, 1);
    let _ = c.resolve_stuck_payment(r.receipt_id);
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn strangers_cannot_start_a_resolution() {
    let (mut c, id) = stuck();
    ctx("stranger.testnet".parse().unwrap(), LIVE + DAY, 1);
    let _ = c.resolve_stuck_payment(id);
}

#[test]
#[should_panic(expected = "deploy under a named account")]
fn contract_refuses_an_implicit_account_that_exists_on_every_network() {
    let mut b = VMContextBuilder::new();
    b.current_account_id("a".repeat(64).parse().unwrap())
        .predecessor_account_id(owner());
    testing_env!(b.build());
    let _ = Contract::new(owner());
}

#[test]
#[should_panic(expected = "storage budget is low")]
fn submissions_stop_before_the_contract_runs_out_of_storage_money() {
    let mut c = setup();
    // A first submission works with the normal balance.
    honest(&mut c, "INV-0", 1, 9, LIVE);
    // Same submission, but the contract's free NEAR is nearly gone.
    let inv = Invoice {
        supplier_id: "qingmar-steel".into(),
        invoice_number: "INV-1".into(),
        order_id: "PO-1184".into(),
        token: "usdc.testnet".into(),
        lines: vec![InvoiceLine {
            sku: "AH36-12mm".into(),
            qty: U64(1),
            unit_price: U128(780 * UNIT),
        }],
        total: U128(780 * UNIT),
        payee: route("qingmar.testnet"),
    };
    let note = DeliveryNote {
        order_id: "PO-1184".into(),
        note_id: "DN-low".into(),
        lines: vec![DeliveredLine {
            sku: "AH36-12mm".into(),
            qty: U64(1),
        }],
    };
    let d1 = InvoiceMessage {
        domain: INVOICE_DOMAIN.into(),
        contract: contract_id(),
        invoice: inv.clone(),
        document_hash: [8; 32],
    }
    .digest();
    let sigs = crate::test_support::two_signatures(&note, &contract_id());
    let mut b = builder(owner(), LIVE, 0);
    b.account_balance(NearToken::from_millinear(1));
    testing_env!(b.build());
    c.submit_invoice(
        inv,
        Base64VecU8(key(SUPPLIER).sign(&d1).to_bytes().to_vec()),
        note,
        sigs,
        Base64VecU8(vec![8; 32]),
    );
}

// ------------------------------------------------------------------ third audit

/// CTP3-01. The supplier was paid but the result was lost; then exactly the same
/// amount arrives by a plain `ft_transfer` (not `ft_transfer_call`), so the balance
/// looks as if the payment never left. The contract cannot tell these apart and
/// records FAILED. This test pins down what that can and cannot cost: a repeat
/// payout can only be funded by the tokens that arrived outside the books, never by
/// the buyer's deposit. The buyer ends with exactly one invoice paid from its money.
#[test]
fn attack_returned_tokens_can_fund_a_repeat_payout_but_never_the_buyers_money() {
    let (mut c, id) = stuck();
    let deposited = 100_000 * UNIT;
    let amount = 7_800 * UNIT;
    // Real token balance: the payout landed (-amount), then someone sent it back (+amount).
    let real_balance = deposited - amount + amount;
    ctx(owner(), LIVE + DAY, 1);
    let _ = c.resolve_stuck_payment(id);
    callback_ctx(LIVE + DAY, balance_result(real_balance));
    assert_eq!(c.on_balance_checked(id, 1), PaymentStatus::Failed);
    // The books match the real balance again.
    let f = c.get_funds(usdc());
    assert_eq!(f.available.0 + f.reserved.0, real_balance);
    // Only the buyer can retry, and only on purpose.
    ctx(owner(), LIVE + DAY + HOUR, 1);
    assert_eq!(c.reauthorize_payment(id), PaymentStatus::Submitted);
    callback_ctx(LIVE + DAY + HOUR, PromiseResult::Successful(vec![]));
    assert_eq!(c.on_payout(id, 2), PaymentStatus::Settled);
    // What the buyer can still withdraw: its deposit minus one invoice. The second
    // transfer was paid with the returned tokens, not with the buyer's money.
    let f = c.get_funds(usdc());
    assert_eq!((f.available.0, f.reserved.0), (deposited - amount, 0));
}

/// CTP3-02. A payout already on its way when the counters started being kept (an
/// in-place upgrade) finds the counter at zero. Its result must still be recorded:
/// the payment settles, the reservation is released, the mismatch is logged.
#[test]
fn a_payout_result_is_recorded_even_if_its_in_flight_counter_is_missing() {
    let (mut c, id) = stuck();
    let mut k = b"inflight:".to_vec();
    k.extend_from_slice(usdc().as_bytes());
    env::storage_remove(&k);
    assert_eq!(c.get_in_flight(usdc()).payouts, 0);
    callback_ctx(LIVE, PromiseResult::Successful(vec![]));
    assert_eq!(c.on_payout(id, 1), PaymentStatus::Settled);
    assert_eq!(c.get_funds(usdc()).reserved, U128(0));
    assert_eq!(c.get_in_flight(usdc()).payouts, 0);
    assert!(
        get_logs()
            .iter()
            .any(|l| l.contains("in_flight_counter_mismatch"))
    );
}

/// CTP3-02, the stuck-payment path: the same missing counter must not block a
/// balance-based resolution either.
#[test]
fn a_stuck_payment_can_be_resolved_even_if_its_in_flight_counter_is_missing() {
    let (mut c, id) = stuck();
    let mut k = b"inflight:".to_vec();
    k.extend_from_slice(usdc().as_bytes());
    env::storage_remove(&k);
    ctx(owner(), LIVE + DAY, 1);
    let _ = c.resolve_stuck_payment(id);
    callback_ctx(LIVE + DAY, balance_result(100_000 * UNIT));
    assert_eq!(c.on_balance_checked(id, 1), PaymentStatus::Failed);
    assert_eq!(c.get_funds(usdc()).reserved, U128(0));
}
