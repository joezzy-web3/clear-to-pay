//! Property tests: the contract's core rules, checked against random inputs and
//! random sequences of actions rather than hand-picked cases.
//!
//! Each sequence case runs in a fresh thread, so every case starts from an empty
//! mock blockchain. A small model tracks what the token contract really holds and
//! which transfers are in flight; after every step the contract must agree with it.
//!
//! Rules:
//!   1. An invoice whose payee is not the address on file is never CLEARED.
//!   2. Money adds up: available + reserved + withdrawals in flight == tokens held,
//!      and reserved == the sum of payments on their way.
//!   3. No sequence of submit / pay / fail / retry / resolve pays an invoice twice.
//!   4. Nothing clears beyond what was delivered, or beyond what was ordered.
//!   5. Any change to a signed invoice, its document fingerprint or its signature
//!      makes the supplier's signature fail: never CLEARED.

use super::inspection::*;
use super::payments::*;
use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{
    NearToken, PromiseOrValue, PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env,
};
use proptest::prelude::*;
use proptest::test_runner::{Config, TestCaseError, TestRunner};
use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};

const HOUR: u64 = 3_600_000_000_000;
const T0: u64 = 1_800_000_000 * 1_000_000_000;
const LIVE: u64 = T0 + 100 * HOUR;
const UNIT: u128 = 1_000_000;
const PRICE: u128 = 780_000; // 0.78 USDC per tonne
const ORDERED: u64 = 30;
const SUPPLIER: u8 = 7;
const STOREKEEPER: u8 = 21;
const SEQUENCE_CASES: u32 = 300;
const SIGNATURE_CASES: u32 = 1000;

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
fn callback_ctx(at: u64, ok: bool) {
    let result = if ok {
        PromiseResult::Successful(vec![])
    } else {
        PromiseResult::Failed
    };
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
            qty: U64(ORDERED),
            unit_price: U128(PRICE),
        }],
    );
    ctx(owner(), T0, 1);
    c.set_limits(U128(100 * UNIT), U128(1_000 * UNIT), U64(720), 1000);
    ctx(owner(), T0, 1);
    c.allow_token(usdc());
    c
}

fn invoice(number: &str, qty: u64, payee: &str) -> Invoice {
    Invoice {
        supplier_id: "qingmar-steel".into(),
        invoice_number: number.into(),
        order_id: "PO-1184".into(),
        token: "usdc.testnet".into(),
        lines: vec![InvoiceLine {
            sku: "AH36-12mm".into(),
            qty: U64(qty),
            unit_price: U128(PRICE),
        }],
        total: U128(qty as u128 * PRICE),
        payee: route(payee),
    }
}
fn invoice_digest(inv: &Invoice, doc: [u8; 32]) -> [u8; 32] {
    InvoiceMessage {
        domain: INVOICE_DOMAIN.into(),
        contract: contract_id(),
        invoice: inv.clone(),
        document_hash: doc,
    }
    .digest()
}
fn signed_note(note_id: &str, delivered: u64) -> (DeliveryNote, Base64VecU8) {
    let note = DeliveryNote {
        order_id: "PO-1184".into(),
        note_id: note_id.into(),
        lines: vec![DeliveredLine {
            sku: "AH36-12mm".into(),
            qty: U64(delivered),
        }],
    };
    let d = DeliveryMessage {
        domain: DELIVERY_DOMAIN.into(),
        contract: contract_id(),
        note: note.clone(),
    }
    .digest();
    (
        note,
        Base64VecU8(key(STOREKEEPER).sign(&d).to_bytes().to_vec()),
    )
}

/// Run one case in its own thread (fresh mock blockchain) and pass its result back.
fn isolated(
    f: impl FnOnce() -> Result<(), TestCaseError> + Send + 'static,
) -> Result<(), TestCaseError> {
    match std::thread::spawn(f).join() {
        Ok(r) => r,
        Err(e) => Err(TestCaseError::fail(format!(
            "unexpected panic: {}",
            e.downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default()
        ))),
    }
}

/// Run property checks with panic messages from refused calls silenced, so the
/// output shows only real failures.
fn run<S: Strategy>(cases: u32, strategy: S, test: impl Fn(S::Value) -> Result<(), TestCaseError>)
where
    S::Value: std::fmt::Debug,
{
    let quiet = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let mut runner = TestRunner::new(Config {
        cases,
        failure_persistence: None,
        ..Config::default()
    });
    let result = runner.run(&strategy, test);
    std::panic::set_hook(quiet);
    if let Err(e) = result {
        panic!("{e}");
    }
}

// ------------------------------------------------------------------ random sequences

#[derive(Clone, Debug)]
enum Op {
    Deposit(u8),
    Submit {
        billed: u64,
        delivered: u64,
        honest_payee: bool,
        honest_signature: bool,
        document: u8,
        reuse_note: bool,
    },
    Execute(u8),
    Payout {
        pick: u8,
        ok: bool,
    },
    Cancel(u8),
    Reauthorize(u8),
    Resolve {
        pick: u8,
        transfer_really_succeeded: bool,
    },
    Withdraw(u8),
    WithdrawResult(bool),
    Wait(u8),
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        2 => (1u8..=20).prop_map(Op::Deposit),
        4 => (1u64..=15, 1u64..=15, prop::bool::weighted(0.8), prop::bool::weighted(0.85), 0u8..12, prop::bool::weighted(0.15))
            .prop_map(|(billed, delivered, honest_payee, honest_signature, document, reuse_note)| Op::Submit {
                billed, delivered, honest_payee, honest_signature, document, reuse_note
            }),
        2 => any::<u8>().prop_map(Op::Execute),
        3 => (any::<u8>(), any::<bool>()).prop_map(|(pick, ok)| Op::Payout { pick, ok }),
        1 => any::<u8>().prop_map(Op::Cancel),
        2 => any::<u8>().prop_map(Op::Reauthorize),
        1 => (any::<u8>(), any::<bool>()).prop_map(|(pick, t)| Op::Resolve { pick, transfer_really_succeeded: t }),
        1 => (1u8..=20).prop_map(Op::Withdraw),
        1 => any::<bool>().prop_map(Op::WithdrawResult),
        2 => (0u8..=60).prop_map(Op::Wait),
    ]
}

/// What really happened, independent of the contract's own bookkeeping.
#[derive(Default)]
struct Model {
    now: u64,
    tokens_held: u128,
    payouts_in_flight: BTreeMap<u32, u128>,
    withdrawals_in_flight: Vec<u128>,
    times_paid: BTreeMap<u32, u32>,
    cleared_tonnes: u64,
    receipts: u32,
    submissions: u32,
}

fn pick(m: &Model, n: u8) -> Option<u32> {
    (m.receipts > 0).then(|| n as u32 % m.receipts)
}

fn owner_call<T>(m: &Model, yocto: u128, f: impl FnOnce() -> T) -> Option<T> {
    ctx(owner(), m.now, yocto);
    catch_unwind(AssertUnwindSafe(f)).ok()
}

fn step(c: &mut Contract, m: &mut Model, op: &Op) -> Result<(), TestCaseError> {
    match *op {
        Op::Deposit(a) => {
            let amount = a as u128 * UNIT;
            ctx(usdc(), m.now, 0);
            match c.ft_on_transfer(owner(), U128(amount), String::new()) {
                PromiseOrValue::Value(v) => prop_assert_eq!(v, U128(0)),
                PromiseOrValue::Promise(_) => prop_assert!(false, "deposit made a promise"),
            }
            m.tokens_held += amount;
        }
        Op::Submit {
            billed,
            delivered,
            honest_payee,
            honest_signature,
            document,
            reuse_note,
        } => {
            m.submissions += 1;
            let number = format!("INV-{}", m.submissions);
            let payee = if honest_payee {
                "qingmar.testnet"
            } else {
                "qingmar-payments.testnet"
            };
            let inv = invoice(&number, billed, payee);
            let doc = [document; 32];
            let signer = if honest_signature { SUPPLIER } else { 99 };
            let sig = key(signer).sign(&invoice_digest(&inv, doc));
            let note_id = if reuse_note {
                "DN-1".to_string()
            } else {
                format!("DN-{}", m.submissions)
            };
            let (note, note_sig) = signed_note(&note_id, delivered);
            ctx(owner(), m.now, 0);
            let r = c.submit_invoice(
                inv,
                Base64VecU8(sig.to_bytes().to_vec()),
                note,
                pk(&key(STOREKEEPER)),
                note_sig,
                Base64VecU8(doc.to_vec()),
            );
            m.receipts += 1;
            if r.verdict == Verdict::Cleared {
                // Rule 1
                prop_assert!(honest_payee, "cleared an invoice with a payee not on file");
                prop_assert!(
                    honest_signature,
                    "cleared an invoice the supplier did not sign"
                );
                // Rule 4
                prop_assert!(billed <= delivered, "cleared more than was delivered");
                m.cleared_tonnes += billed;
                prop_assert!(m.cleared_tonnes <= ORDERED, "cleared more than was ordered");
            } else {
                prop_assert!(
                    r.payment.is_none(),
                    "a non-cleared invoice created a payment"
                );
            }
        }
        Op::Execute(n) => {
            if let Some(id) = pick(m, n) {
                owner_call(m, 0, || c.execute_payment(id));
            }
        }
        Op::Payout { pick: n, ok } => {
            let Some(id) = pick(m, n) else { return Ok(()) };
            callback_ctx(m.now, ok);
            let result = catch_unwind(AssertUnwindSafe(|| c.on_payout(id)));
            match m.payouts_in_flight.remove(&id) {
                Some(amount) => {
                    prop_assert!(result.is_ok(), "the real result of a transfer was refused");
                    if ok {
                        m.tokens_held -= amount;
                        *m.times_paid.entry(id).or_default() += 1;
                    }
                }
                // No transfer is in flight for this receipt: a callback must be refused.
                None => prop_assert!(result.is_err(), "a callback with no transfer moved state"),
            }
        }
        Op::Cancel(n) => {
            if let Some(id) = pick(m, n) {
                owner_call(m, 1, || c.cancel_payment(id));
            }
        }
        Op::Reauthorize(n) => {
            if let Some(id) = pick(m, n) {
                owner_call(m, 1, || c.reauthorize_payment(id));
            }
        }
        Op::Resolve {
            pick: n,
            transfer_really_succeeded,
        } => {
            let Some(id) = pick(m, n) else { return Ok(()) };
            // The buyer reports what the token contract's records show.
            let resolved = owner_call(m, 1, || {
                c.resolve_stuck_payment(id, transfer_really_succeeded)
            });
            if resolved.is_some() {
                let amount = m.payouts_in_flight.remove(&id);
                prop_assert!(
                    amount.is_some(),
                    "resolved a payment that was not in flight"
                );
                if transfer_really_succeeded {
                    m.tokens_held -= amount.unwrap();
                    *m.times_paid.entry(id).or_default() += 1;
                }
            }
        }
        Op::Withdraw(a) => {
            let amount = a as u128 * UNIT;
            if owner_call(m, 1, || {
                let _ = c.withdraw(usdc(), U128(amount));
            })
            .is_some()
            {
                m.withdrawals_in_flight.push(amount);
            }
        }
        Op::WithdrawResult(ok) => {
            if m.withdrawals_in_flight.is_empty() {
                return Ok(());
            }
            let amount = m.withdrawals_in_flight.remove(0);
            callback_ctx(m.now, ok);
            c.on_withdraw(usdc(), U128(amount));
            if ok {
                m.tokens_held -= amount;
            }
        }
        Op::Wait(h) => m.now += h as u64 * HOUR,
    }
    Ok(())
}

/// Record transfers the contract just started, then check every rule.
fn check(c: &Contract, m: &mut Model) -> Result<(), TestCaseError> {
    let mut reserved_for_flights = 0u128;
    for id in 0..m.receipts {
        let Some(p) = c.get_payment(id) else { continue };
        // Never left half-way: RESERVED only exists inside a single call.
        prop_assert_ne!(p.status, PaymentStatus::Reserved);
        if p.status == PaymentStatus::Submitted {
            m.payouts_in_flight.entry(id).or_insert(p.amount.0);
            prop_assert_eq!(m.payouts_in_flight[&id], p.amount.0);
            reserved_for_flights += p.amount.0;
        } else {
            prop_assert!(
                !m.payouts_in_flight.contains_key(&id),
                "a transfer is in flight but the payment is {:?}",
                p.status
            );
        }
        // Rule 3
        let paid = m.times_paid.get(&id).copied().unwrap_or(0);
        prop_assert!(paid <= 1, "receipt {} was paid {} times", id, paid);
        prop_assert_eq!(p.status == PaymentStatus::Settled, paid == 1);
    }
    // Rule 2
    let f = c.get_funds(usdc());
    let withdrawing: u128 = m.withdrawals_in_flight.iter().sum();
    prop_assert_eq!(f.available.0 + f.reserved.0 + withdrawing, m.tokens_held);
    prop_assert_eq!(f.reserved.0, reserved_for_flights);
    Ok(())
}

#[test]
fn property_random_action_sequences_keep_every_money_rule() {
    run(SEQUENCE_CASES, prop::collection::vec(op(), 1..40), |ops| {
        isolated(move || {
            let mut c = setup();
            let mut m = Model {
                now: LIVE,
                ..Model::default()
            };
            for op in &ops {
                step(&mut c, &mut m, op)?;
                check(&c, &mut m)?;
            }
            Ok(())
        })
    });
}

// ------------------------------------------------------------------ rule 5: tampering

#[derive(Clone, Debug)]
enum Tamper {
    SignatureBit(usize, u8),
    Quantity(u64),
    UnitPrice(u128),
    Total(u128),
    PayeeByte(usize, u8),
    InvoiceNumber(String),
    DocumentByte(usize, u8),
}

fn tamper() -> impl Strategy<Value = Tamper> {
    prop_oneof![
        (0usize..64, 0u8..8).prop_map(|(i, b)| Tamper::SignatureBit(i, b)),
        (1u64..=10).prop_map(Tamper::Quantity),
        (1u128..=2_000_000).prop_map(Tamper::UnitPrice),
        (1u128..=20_000_000).prop_map(Tamper::Total),
        (0usize..15, 1u8..=255).prop_map(|(i, x)| Tamper::PayeeByte(i, x)),
        "INV-[0-9]{1,4}".prop_map(Tamper::InvoiceNumber),
        (0usize..32, 1u8..=255).prop_map(|(i, x)| Tamper::DocumentByte(i, x)),
    ]
}

#[test]
fn property_any_change_after_signing_is_never_cleared() {
    run(SIGNATURE_CASES, (1u64..=10, tamper()), |(qty, t)| {
        isolated(move || {
            let mut c = setup();
            let mut inv = invoice("INV-1", qty, "qingmar.testnet");
            let signed_doc = [5u8; 32];
            let mut sig = key(SUPPLIER)
                .sign(&invoice_digest(&inv, signed_doc))
                .to_bytes();
            let mut doc = signed_doc;
            match &t {
                Tamper::SignatureBit(i, b) => sig[*i] ^= 1 << b,
                Tamper::Quantity(q) => {
                    if *q == qty {
                        return Ok(());
                    }
                    inv.lines[0].qty = U64(*q);
                    inv.total = U128(*q as u128 * PRICE);
                }
                Tamper::UnitPrice(p) => {
                    if *p == PRICE {
                        return Ok(());
                    }
                    inv.lines[0].unit_price = U128(*p);
                }
                Tamper::Total(x) => {
                    if *x == inv.total.0 {
                        return Ok(());
                    }
                    inv.total = U128(*x);
                }
                Tamper::PayeeByte(i, x) => {
                    let mut b = inv.payee.address.clone().into_bytes();
                    b[*i] ^= x;
                    let Ok(s) = String::from_utf8(b) else {
                        return Ok(());
                    };
                    inv.payee.address = s;
                }
                Tamper::InvoiceNumber(n) => {
                    if n == "INV-1" {
                        return Ok(());
                    }
                    inv.invoice_number = n.clone();
                }
                Tamper::DocumentByte(i, x) => doc[*i] ^= x,
            }
            let (note, note_sig) = signed_note("DN-1", 10);
            ctx(owner(), LIVE, 0);
            // A tampered field may also be refused outright (e.g. an address with an
            // invalid character); that is just as safe as a SEIZED verdict.
            let r = catch_unwind(AssertUnwindSafe(|| {
                c.submit_invoice(
                    inv,
                    Base64VecU8(sig.to_vec()),
                    note,
                    pk(&key(STOREKEEPER)),
                    note_sig,
                    Base64VecU8(doc.to_vec()),
                )
            }));
            if let Ok(r) = r {
                prop_assert_ne!(
                    r.verdict,
                    Verdict::Cleared,
                    "tampering {:?} still cleared",
                    t
                );
                prop_assert!(
                    r.reasons.iter().any(|x| x == "invalid_supplier_signature"),
                    "tampering {:?} not caught by the signature: {:?}",
                    t,
                    r.reasons
                );
            }
            Ok(())
        })
    });
}

/// Control for rule 5: the same invoice, untouched, does clear.
#[test]
fn property_control_untampered_invoice_clears() {
    let mut c = setup();
    let inv = invoice("INV-1", 10, "qingmar.testnet");
    let sig = key(SUPPLIER).sign(&invoice_digest(&inv, [5u8; 32]));
    let (note, note_sig) = signed_note("DN-1", 10);
    ctx(owner(), LIVE, 0);
    let r = c.submit_invoice(
        inv,
        Base64VecU8(sig.to_bytes().to_vec()),
        note,
        pk(&key(STOREKEEPER)),
        note_sig,
        Base64VecU8(vec![5u8; 32]),
    );
    assert_eq!(r.verdict, Verdict::Cleared, "{:?}", r.reasons);
}
