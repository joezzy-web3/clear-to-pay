//! Payment tests: deposits, the state machine, callbacks, withdrawals.

use super::inspection::*;
use super::payments::*;
use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{
    NearToken, PromiseOrValue, PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env,
};

const HOUR: u64 = 3_600_000_000_000;
const T0: u64 = 1_800_000_000 * 1_000_000_000;
const LIVE: u64 = T0 + 100 * HOUR;
const UNIT: u128 = 1_000_000;

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
/// Context for a callback, with the result of the promise it follows.
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
fn route(chain: &str, addr: &str) -> PayoutRoute {
    PayoutRoute {
        chain: chain.into(),
        token: "usdc.testnet".into(),
        address: addr.into(),
    }
}

fn setup(supplier_route: PayoutRoute) -> Contract {
    ctx(owner(), T0, 0);
    let mut c = Contract::new(owner());
    ctx(owner(), T0, 1);
    c.register_supplier("qingmar-steel".into(), pk(&key(7)), supplier_route);
    ctx(owner(), T0, 1);
    c.add_storekeeper(pk(&key(21)));
    ctx(owner(), T0, 1);
    c.create_order(
        "PO-1184".into(),
        "qingmar-steel".into(),
        "usdc.testnet".into(),
        vec![OrderLine {
            sku: "AH36-12mm".into(),
            qty: U64(100),
            unit_price: U128(780 * UNIT),
        }],
    );
    ctx(owner(), T0, 1);
    c.set_limits(U128(100_000 * UNIT), U128(250_000 * UNIT), U64(720), 100);
    ctx(owner(), T0, 1);
    c.allow_token(usdc());
    c
}

fn deposit(c: &mut Contract, from: AccountId, token: AccountId, amount: u128) -> U128 {
    ctx(token, LIVE, 0); // the token contract calls ft_on_transfer
    match c.ft_on_transfer(from, U128(amount), String::new()) {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

fn clear_invoice(
    c: &mut Contract,
    number: &str,
    qty: u64,
    payee: PayoutRoute,
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
        payee,
    };
    let note = DeliveryNote {
        order_id: "PO-1184".into(),
        note_id: format!("DN-{number}"),
        lines: vec![DeliveredLine {
            sku: "AH36-12mm".into(),
            qty: U64(qty),
        }],
    };
    let fingerprint = env::sha256_array(number.as_bytes()); // a distinct fingerprint per invoice
    let d1 = InvoiceMessage {
        domain: INVOICE_DOMAIN.into(),
        contract: contract_id(),
        invoice: inv.clone(),
        document_hash: fingerprint,
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
        Base64VecU8(key(7).sign(&d1).to_bytes().to_vec()),
        note,
        pk(&key(21)),
        Base64VecU8(key(21).sign(&d2).to_bytes().to_vec()),
        Base64VecU8(fingerprint.to_vec()),
    )
}

/// Outgoing calls created in this test: (receiver, method, args as text).
fn calls() -> Vec<(String, String, String)> {
    let mut out = vec![];
    for r in get_created_receipts() {
        for a in r.actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight {
                method_name, args, ..
            } = a
            {
                out.push((
                    r.receiver_id.to_string(),
                    String::from_utf8_lossy(&method_name).into_owned(),
                    String::from_utf8_lossy(&args).into_owned(),
                ));
            }
        }
    }
    out
}

fn near_route() -> PayoutRoute {
    route("near", "qingmar.testnet")
}

// ---------------------------------------------------------------------- deposits

#[test]
fn buyer_deposit_of_an_allowed_token_is_kept() {
    let mut c = setup(near_route());
    assert_eq!(deposit(&mut c, owner(), usdc(), 100_000 * UNIT), U128(0));
    assert_eq!(c.get_funds(usdc()).available, U128(100_000 * UNIT));
}

#[test]
fn deposits_from_anyone_else_are_returned() {
    let mut c = setup(near_route());
    let refund = deposit(
        &mut c,
        "stranger.testnet".parse().unwrap(),
        usdc(),
        5 * UNIT,
    );
    assert_eq!(refund, U128(5 * UNIT));
    assert_eq!(c.get_funds(usdc()).available, U128(0));
}

#[test]
fn deposits_of_an_unknown_token_are_returned() {
    let mut c = setup(near_route());
    let fake: AccountId = "fake-usdc.testnet".parse().unwrap();
    assert_eq!(
        deposit(&mut c, owner(), fake.clone(), 5 * UNIT),
        U128(5 * UNIT)
    );
    assert_eq!(c.get_funds(fake).available, U128(0));
}

// ---------------------------------------------------------------------- paying

#[test]
fn cleared_invoice_with_funds_is_reserved_and_sent_to_the_registered_route() {
    let mut c = setup(near_route());
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    let r = clear_invoice(&mut c, "INV-2208", 100, near_route(), LIVE);
    assert_eq!(r.verdict, Verdict::Cleared);
    assert_eq!(r.payment, Some(PaymentStatus::Submitted));
    let f = c.get_funds(usdc());
    assert_eq!(f.available, U128(22_000 * UNIT));
    assert_eq!(f.reserved, U128(78_000 * UNIT));
    // The outgoing call is a USDC transfer of exactly 78,000 to the registered address,
    // followed by the contract's own callback.
    let c2 = calls();
    let t = c2
        .iter()
        .find(|(_, m, _)| m == "ft_transfer")
        .expect("transfer created");
    assert_eq!(t.0, "usdc.testnet");
    assert!(
        t.2.contains("\"receiver_id\":\"qingmar.testnet\"")
            && t.2.contains("\"amount\":\"78000000000\"")
    );
    assert!(
        c2.iter()
            .any(|(rcv, m, _)| rcv == "cleartopay.testnet" && m == "on_payout")
    );
}

#[test]
fn successful_transfer_settles_the_payment() {
    let mut c = setup(near_route());
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    let r = clear_invoice(&mut c, "INV-2208", 100, near_route(), LIVE);
    callback_ctx(LIVE, PromiseResult::Successful(vec![]));
    assert_eq!(c.on_payout(r.receipt_id, 1), PaymentStatus::Settled);
    let f = c.get_funds(usdc());
    assert_eq!((f.available, f.reserved), (U128(22_000 * UNIT), U128(0)));
    assert_eq!(
        c.get_payment(r.receipt_id).unwrap().status,
        PaymentStatus::Settled
    );
}

#[test]
fn failed_transfer_returns_the_money_to_the_pool() {
    let mut c = setup(near_route());
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    let r = clear_invoice(&mut c, "INV-2208", 100, near_route(), LIVE);
    callback_ctx(LIVE, PromiseResult::Failed);
    assert_eq!(c.on_payout(r.receipt_id, 1), PaymentStatus::Failed);
    let f = c.get_funds(usdc());
    assert_eq!((f.available, f.reserved), (U128(100_000 * UNIT), U128(0)));
}

#[test]
fn cleared_without_funds_waits_then_pays_after_a_deposit() {
    let mut c = setup(near_route());
    let r = clear_invoice(&mut c, "INV-2208", 100, near_route(), LIVE);
    assert_eq!(r.payment, Some(PaymentStatus::Authorized));
    assert!(get_logs().iter().any(|l| l.contains("insufficient_funds")));
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    ctx(owner(), LIVE + HOUR, 0);
    assert_eq!(c.execute_payment(r.receipt_id), PaymentStatus::Submitted);
}

#[test]
fn a_cleared_payment_not_paid_within_7_days_expires() {
    let mut c = setup(near_route());
    let r = clear_invoice(&mut c, "INV-2208", 100, near_route(), LIVE);
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    ctx(owner(), LIVE + 7 * 24 * HOUR + 1, 0);
    assert_eq!(c.execute_payment(r.receipt_id), PaymentStatus::Expired);
    assert_eq!(c.get_funds(usdc()).available, U128(100_000 * UNIT));
}

#[test]
fn if_the_route_changes_before_payment_the_old_one_is_not_paid() {
    let mut c = setup(near_route());
    let r = clear_invoice(&mut c, "INV-2208", 100, near_route(), LIVE);
    assert_eq!(r.payment, Some(PaymentStatus::Authorized)); // no funds yet
    // A signed, approved change moves the supplier to a new address...
    let new = route("near", "qingmar-new.testnet");
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
        new,
        U64(1),
        Base64VecU8(key(7).sign(&d).to_bytes().to_vec()),
    );
    ctx(owner(), LIVE, 1);
    c.approve_payout_change("qingmar-steel".into());
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    // ...so once it takes effect, the payment to the old address is held back.
    ctx(owner(), LIVE + 73 * HOUR, 0);
    assert_eq!(c.execute_payment(r.receipt_id), PaymentStatus::Authorized);
    assert!(
        get_logs()
            .iter()
            .any(|l| l.contains("route_no_longer_payable"))
    );
    assert_eq!(c.get_funds(usdc()).reserved, U128(0));
}

#[test]
fn cross_chain_routes_wait_for_intents() {
    let base = route("base", "0x00000000000000000000000000000000000000b0");
    let mut c = setup(base.clone());
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    let r = clear_invoice(&mut c, "INV-2208", 100, base, LIVE);
    assert_eq!(r.payment, Some(PaymentStatus::Authorized));
    assert!(get_logs().iter().any(|l| l.contains("route_needs_intents")));
    assert_eq!(c.get_funds(usdc()).reserved, U128(0));
}

#[test]
fn held_and_seized_invoices_create_no_payment() {
    let mut c = setup(near_route());
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    let seized = clear_invoice(
        &mut c,
        "INV-X",
        100,
        route("near", "attacker.testnet"),
        LIVE,
    );
    assert_eq!(seized.verdict, Verdict::Seized);
    assert_eq!(seized.payment, None);
    assert!(c.get_payment(seized.receipt_id).is_none());
    assert_eq!(c.get_funds(usdc()).available, U128(100_000 * UNIT));
}

// ---------------------------------------------------------------------- the state machine

#[test]
#[should_panic(expected = "payment is not waiting to be paid")]
fn a_settled_payment_can_never_be_paid_again() {
    let mut c = setup(near_route());
    deposit(&mut c, owner(), usdc(), 200_000 * UNIT);
    let r = clear_invoice(&mut c, "INV-2208", 100, near_route(), LIVE);
    callback_ctx(LIVE, PromiseResult::Successful(vec![]));
    c.on_payout(r.receipt_id, 1);
    ctx(owner(), LIVE, 0);
    c.execute_payment(r.receipt_id);
}

#[test]
#[should_panic(expected = "illegal payment transition Settled -> Settled")]
fn a_callback_cannot_settle_the_same_payment_twice() {
    let mut c = setup(near_route());
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    let r = clear_invoice(&mut c, "INV-2208", 100, near_route(), LIVE);
    callback_ctx(LIVE, PromiseResult::Successful(vec![]));
    c.on_payout(r.receipt_id, 1);
    callback_ctx(LIVE, PromiseResult::Successful(vec![]));
    c.on_payout(r.receipt_id, 1);
}

#[test]
#[should_panic(expected = "only this contract can report payout results")]
fn strangers_cannot_fake_a_payout_callback() {
    let mut c = setup(near_route());
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    let r = clear_invoice(&mut c, "INV-2208", 100, near_route(), LIVE);
    ctx("stranger.testnet".parse().unwrap(), LIVE, 0);
    c.on_payout(r.receipt_id, 1);
}

#[test]
#[should_panic(expected = "illegal payment transition Submitted -> Cancelled")]
fn a_payment_already_sent_cannot_be_cancelled() {
    let mut c = setup(near_route());
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    let r = clear_invoice(&mut c, "INV-2208", 100, near_route(), LIVE);
    ctx(owner(), LIVE, 1);
    c.cancel_payment(r.receipt_id);
}

#[test]
fn a_waiting_payment_can_be_cancelled_by_the_buyer() {
    let mut c = setup(near_route());
    let r = clear_invoice(&mut c, "INV-2208", 100, near_route(), LIVE);
    ctx(owner(), LIVE, 1);
    c.cancel_payment(r.receipt_id);
    assert_eq!(
        c.get_payment(r.receipt_id).unwrap().status,
        PaymentStatus::Cancelled
    );
}

// ---------------------------------------------------------------------- withdrawals

#[test]
fn withdraw_only_pays_the_owner_and_never_touches_reserved_money() {
    let mut c = setup(near_route());
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    clear_invoice(&mut c, "INV-2208", 100, near_route(), LIVE); // reserves 78,000
    ctx(owner(), LIVE, 1);
    let _ = c.withdraw(usdc(), U128(22_000 * UNIT));
    let t = calls()
        .into_iter()
        .find(|(_, m, _)| m == "ft_transfer")
        .expect("transfer created");
    assert!(t.2.contains("\"receiver_id\":\"buyer.testnet\""));
    let f = c.get_funds(usdc());
    assert_eq!((f.available, f.reserved), (U128(0), U128(78_000 * UNIT)));
}

#[test]
#[should_panic(expected = "not enough unreserved funds")]
fn withdraw_cannot_take_reserved_money() {
    let mut c = setup(near_route());
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    clear_invoice(&mut c, "INV-2208", 100, near_route(), LIVE);
    ctx(owner(), LIVE, 1);
    let _ = c.withdraw(usdc(), U128(22_001 * UNIT));
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn strangers_cannot_withdraw() {
    let mut c = setup(near_route());
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    ctx("stranger.testnet".parse().unwrap(), LIVE, 1);
    let _ = c.withdraw(usdc(), U128(1));
}

#[test]
fn failed_withdraw_puts_the_money_back() {
    let mut c = setup(near_route());
    deposit(&mut c, owner(), usdc(), 100_000 * UNIT);
    ctx(owner(), LIVE, 1);
    let _ = c.withdraw(usdc(), U128(100_000 * UNIT));
    callback_ctx(LIVE, PromiseResult::Failed);
    assert!(!c.on_withdraw(usdc(), U128(100_000 * UNIT)));
    assert_eq!(c.get_funds(usdc()).available, U128(100_000 * UNIT));
}
