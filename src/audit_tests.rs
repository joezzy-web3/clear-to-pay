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
    let d2 = DeliveryMessage {
        domain: DELIVERY_DOMAIN.into(),
        contract: contract_id(),
        note: note.clone(),
    }
    .digest();
    ctx(owner(), at, 0);
    c.submit_invoice(
        inv,
        Base64VecU8(key(signer).sign(&d1).to_bytes().to_vec()),
        note,
        pk(&key(STOREKEEPER)),
        Base64VecU8(key(STOREKEEPER).sign(&d2).to_bytes().to_vec()),
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
    assert_eq!(c.on_payout(r.receipt_id), PaymentStatus::Failed);
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
    c.on_payout(r.receipt_id);
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
    c.on_payout(r.receipt_id);
}

#[test]
#[should_panic(expected = "a submitted payment can only be resolved 24 hours after it was sent")]
fn stuck_payment_cannot_be_resolved_early() {
    let mut c = setup();
    deposit(&mut c, 100_000 * UNIT);
    let r = honest(&mut c, "INV-1", 10, 1, LIVE);
    ctx(owner(), LIVE + 23 * HOUR, 1);
    c.resolve_stuck_payment(r.receipt_id, false);
}

#[test]
fn stuck_payment_resolved_as_unpaid_returns_the_money_once() {
    let mut c = setup();
    deposit(&mut c, 100_000 * UNIT);
    let r = honest(&mut c, "INV-1", 10, 1, LIVE);
    ctx(owner(), LIVE + DAY, 1);
    assert_eq!(
        c.resolve_stuck_payment(r.receipt_id, false),
        PaymentStatus::Failed
    );
    let f = c.get_funds(usdc());
    assert_eq!((f.available, f.reserved), (U128(100_000 * UNIT), U128(0)));
    assert!(
        get_logs()
            .iter()
            .any(|l| l.contains("payment_resolved_by_buyer"))
    );
    // A late callback cannot then move the money a second time.
    callback_ctx(LIVE + DAY, PromiseResult::Successful(vec![]));
    let late = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.on_payout(r.receipt_id)));
    assert!(late.is_err());
}

#[test]
fn stuck_payment_resolved_as_paid_releases_the_reservation() {
    let mut c = setup();
    deposit(&mut c, 100_000 * UNIT);
    let r = honest(&mut c, "INV-1", 10, 1, LIVE);
    ctx(owner(), LIVE + DAY, 1);
    assert_eq!(
        c.resolve_stuck_payment(r.receipt_id, true),
        PaymentStatus::Settled
    );
    let f = c.get_funds(usdc());
    assert_eq!((f.available, f.reserved), (U128(92_200 * UNIT), U128(0)));
}

#[test]
#[should_panic(expected = "only a submitted payment can be resolved")]
fn only_submitted_payments_can_be_resolved() {
    let mut c = setup();
    let r = honest(&mut c, "INV-1", 10, 1, LIVE); // no funds: AUTHORIZED
    ctx(owner(), LIVE + 2 * DAY, 1);
    c.resolve_stuck_payment(r.receipt_id, true);
}
