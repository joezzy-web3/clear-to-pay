//! Inspection tests. Scenario: Qingmar Steel (fictional) supplies steel plate
//! against order PO-1184: 100 t of AH36 at 780 USDC per tonne.

use super::inspection::*;
use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{NearToken, testing_env};

const HOUR: u64 = 3_600_000_000_000;
const T0: u64 = 1_800_000_000 * 1_000_000_000;
const LIVE: u64 = T0 + 100 * HOUR; // supplier route is payable by now
const USDC: &str = "usdc.testnet";
const UNIT: u128 = 1_000_000; // 6 decimals

fn owner() -> AccountId {
    "buyer.testnet".parse().unwrap()
}
fn contract_id() -> AccountId {
    "cleartopay.testnet".parse().unwrap()
}
fn ctx(caller: AccountId, at: u64, yocto: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(caller.clone())
        .signer_account_id(caller)
        .block_timestamp(at)
        .attached_deposit(NearToken::from_yoctonear(yocto));
    testing_env!(b.build());
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
        token: USDC.into(),
        address: addr.into(),
    }
}

const SUPPLIER: u8 = 7;
const STOREKEEPER: u8 = 21;

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
        USDC.into(),
        vec![OrderLine {
            sku: "AH36-12mm".into(),
            qty: U64(100),
            unit_price: U128(780 * UNIT),
        }],
    );
    ctx(owner(), T0, 1);
    c.set_limits(U128(100_000 * UNIT), U128(250_000 * UNIT), U64(24 * 30));
    c
}

fn invoice(number: &str, qty: u64, price: u128, total: u128, payee: &str) -> Invoice {
    Invoice {
        supplier_id: "qingmar-steel".into(),
        invoice_number: number.into(),
        order_id: "PO-1184".into(),
        token: USDC.into(),
        lines: vec![InvoiceLine {
            sku: "AH36-12mm".into(),
            qty: U64(qty),
            unit_price: U128(price * UNIT),
        }],
        total: U128(total * UNIT),
        payee: route(payee),
    }
}
fn delivery(note: &str, qty: u64) -> DeliveryNote {
    DeliveryNote {
        order_id: "PO-1184".into(),
        note_id: note.into(),
        lines: vec![DeliveredLine {
            sku: "AH36-12mm".into(),
            qty: U64(qty),
        }],
    }
}
fn sign_invoice(k: &SigningKey, inv: &Invoice) -> Base64VecU8 {
    let d = InvoiceMessage {
        domain: INVOICE_DOMAIN.into(),
        contract: contract_id(),
        invoice: inv.clone(),
    }
    .digest();
    Base64VecU8(k.sign(&d).to_bytes().to_vec())
}
fn sign_delivery(k: &SigningKey, n: &DeliveryNote) -> Base64VecU8 {
    let d = DeliveryMessage {
        domain: DELIVERY_DOMAIN.into(),
        contract: contract_id(),
        note: n.clone(),
    }
    .digest();
    Base64VecU8(k.sign(&d).to_bytes().to_vec())
}
fn doc(n: u8) -> Base64VecU8 {
    Base64VecU8(vec![n; 32])
}

/// Submit with honest signatures by default.
fn submit(c: &mut Contract, inv: Invoice, note: DeliveryNote, document: u8) -> InspectionResult {
    let s1 = sign_invoice(&key(SUPPLIER), &inv);
    let s2 = sign_delivery(&key(STOREKEEPER), &note);
    ctx(owner(), LIVE, 0);
    c.submit_invoice(inv, s1, note, pk(&key(STOREKEEPER)), s2, doc(document))
}

fn has(r: &InspectionResult, code: &str) -> bool {
    r.reasons.iter().any(|x| x == code)
}

// ---------------------------------------------------------------------- the clean path

#[test]
fn clean_invoice_clears_and_writes_a_receipt() {
    let mut c = setup();
    let r = submit(
        &mut c,
        invoice("INV-2208", 100, 780, 78_000, "qingmar.testnet"),
        delivery("DN-552", 100),
        1,
    );
    assert_eq!(r.verdict, Verdict::Cleared, "reasons: {:?}", r.reasons);
    assert!(r.reasons.is_empty());
    let receipt = c.get_receipt(r.receipt_id).unwrap();
    assert_eq!(receipt.amount, U128(78_000 * UNIT));
    assert_eq!(receipt.document_hash, "01".repeat(32));
    assert_eq!(c.receipt_count(), 1);
    assert_eq!(c.get_order("PO-1184".into()).unwrap().invoiced[0], U64(100));
    assert!(
        get_logs()
            .iter()
            .any(|l| l.contains("\"invoice_inspected\"") && l.contains("\"Cleared\""))
    );
}

#[test]
fn partial_deliveries_can_be_invoiced_separately_up_to_the_order() {
    let mut c = setup();
    let a = submit(
        &mut c,
        invoice("INV-1", 60, 780, 46_800, "qingmar.testnet"),
        delivery("DN-1", 60),
        1,
    );
    let b = submit(
        &mut c,
        invoice("INV-2", 40, 780, 31_200, "qingmar.testnet"),
        delivery("DN-2", 40),
        2,
    );
    assert_eq!((a.verdict, b.verdict), (Verdict::Cleared, Verdict::Cleared));
    let extra = submit(
        &mut c,
        invoice("INV-3", 1, 780, 780, "qingmar.testnet"),
        delivery("DN-3", 1),
        3,
    );
    assert_eq!(extra.verdict, Verdict::Held);
    assert!(has(&extra, "quantity_exceeds_order"));
}

// ---------------------------------------------------------------------- HELD: numbers that don't add up

#[test]
fn billing_more_than_was_delivered_is_held() {
    let mut c = setup();
    // The weighbridge says 100 t, the invoice says 120 t.
    let r = submit(
        &mut c,
        invoice("INV-2209", 120, 780, 93_600, "qingmar.testnet"),
        delivery("DN-552", 100),
        1,
    );
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "quantity_exceeds_delivery"));
}

#[test]
fn held_invoice_can_be_corrected_and_resubmitted() {
    let mut c = setup();
    let held = submit(
        &mut c,
        invoice("INV-2209", 120, 780, 93_600, "qingmar.testnet"),
        delivery("DN-552", 100),
        1,
    );
    assert_eq!(held.verdict, Verdict::Held);
    // The supplier reissues the same invoice number for the right quantity.
    let fixed = submit(
        &mut c,
        invoice("INV-2209", 100, 780, 78_000, "qingmar.testnet"),
        delivery("DN-552", 100),
        2,
    );
    assert_eq!(
        fixed.verdict,
        Verdict::Cleared,
        "reasons: {:?}",
        fixed.reasons
    );
}

#[test]
fn price_different_from_the_order_is_held() {
    let mut c = setup();
    let r = submit(
        &mut c,
        invoice("INV-1", 100, 790, 79_000, "qingmar.testnet"),
        delivery("DN-1", 100),
        1,
    );
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "price_mismatch"));
}

#[test]
fn total_that_does_not_match_the_lines_is_held() {
    let mut c = setup();
    let r = submit(
        &mut c,
        invoice("INV-1", 100, 780, 87_000, "qingmar.testnet"),
        delivery("DN-1", 100),
        1,
    );
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "total_mismatch"));
}

#[test]
fn delivery_note_signed_by_an_unknown_key_is_held() {
    let mut c = setup();
    let inv = invoice("INV-1", 100, 780, 78_000, "qingmar.testnet");
    let note = delivery("DN-1", 100);
    let s1 = sign_invoice(&key(SUPPLIER), &inv);
    let fake = key(99); // "storekeeper" the buyer never registered
    let s2 = sign_delivery(&fake, &note);
    ctx(owner(), LIVE, 0);
    let r = c.submit_invoice(inv, s1, note, pk(&fake), s2, doc(1));
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "unknown_storekeeper"));
}

#[test]
fn delivery_note_edited_after_signing_is_held() {
    let mut c = setup();
    let inv = invoice("INV-1", 120, 780, 93_600, "qingmar.testnet");
    let s1 = sign_invoice(&key(SUPPLIER), &inv);
    let s2 = sign_delivery(&key(STOREKEEPER), &delivery("DN-1", 100));
    ctx(owner(), LIVE, 0);
    // Someone changes 100 to 120 on the note after the storekeeper signed it.
    let r = c.submit_invoice(
        inv,
        s1,
        delivery("DN-1", 120),
        pk(&key(STOREKEEPER)),
        s2,
        doc(1),
    );
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "invalid_delivery_signature"));
}

#[test]
fn nothing_clears_until_limits_are_set() {
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
        USDC.into(),
        vec![OrderLine {
            sku: "AH36-12mm".into(),
            qty: U64(100),
            unit_price: U128(780 * UNIT),
        }],
    );
    let r = submit(
        &mut c,
        invoice("INV-1", 100, 780, 78_000, "qingmar.testnet"),
        delivery("DN-1", 100),
        1,
    );
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "limits_not_set"));
}

#[test]
fn invoice_over_the_single_invoice_limit_is_held() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.set_limits(U128(50_000 * UNIT), U128(250_000 * UNIT), U64(720));
    let r = submit(
        &mut c,
        invoice("INV-1", 100, 780, 78_000, "qingmar.testnet"),
        delivery("DN-1", 100),
        1,
    );
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "over_invoice_limit"));
}

#[test]
fn attack_splitting_invoices_to_dodge_the_limit_hits_the_period_limit() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.set_limits(U128(40_000 * UNIT), U128(60_000 * UNIT), U64(720));
    // 78,000 split into 39,000 + 39,000: each is under the single-invoice limit.
    let a = submit(
        &mut c,
        invoice("INV-1a", 50, 780, 39_000, "qingmar.testnet"),
        delivery("DN-1", 50),
        1,
    );
    let b = submit(
        &mut c,
        invoice("INV-1b", 50, 780, 39_000, "qingmar.testnet"),
        delivery("DN-2", 50),
        2,
    );
    assert_eq!(a.verdict, Verdict::Cleared);
    assert_eq!(b.verdict, Verdict::Held);
    assert!(has(&b, "over_period_limit"));
}

#[test]
fn unknown_supplier_is_held_not_called_fraud() {
    let mut c = setup();
    let mut inv = invoice("INV-1", 100, 780, 78_000, "newco.testnet");
    inv.supplier_id = "new-supplier".into();
    let r = submit(&mut c, inv, delivery("DN-1", 100), 1);
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "unknown_supplier"));
}

#[test]
fn route_still_in_its_72_hours_is_held() {
    let mut c = setup();
    let inv = invoice("INV-1", 100, 780, 78_000, "qingmar.testnet");
    let note = delivery("DN-1", 100);
    let s1 = sign_invoice(&key(SUPPLIER), &inv);
    let s2 = sign_delivery(&key(STOREKEEPER), &note);
    ctx(owner(), T0 + HOUR, 0); // supplier registered only an hour ago
    let r = c.submit_invoice(inv, s1, note, pk(&key(STOREKEEPER)), s2, doc(1));
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "payee_not_yet_payable"));
}

// ---------------------------------------------------------------------- SEIZED: the attacks

#[test]
fn attack_new_bank_details_on_a_signed_looking_invoice_is_seized() {
    let mut c = setup();
    // The attacker controls the email thread but not the supplier's key, so they
    // sign with their own key and point the payee at themselves.
    let inv = invoice("INV-2210", 100, 780, 78_000, "attacker.testnet");
    let note = delivery("DN-552", 100);
    let s1 = sign_invoice(&key(66), &inv);
    let s2 = sign_delivery(&key(STOREKEEPER), &note);
    ctx(owner(), LIVE, 0);
    let r = c.submit_invoice(inv, s1, note, pk(&key(STOREKEEPER)), s2, doc(1));
    assert_eq!(r.verdict, Verdict::Seized);
    assert!(has(&r, "invalid_supplier_signature"));
    assert!(has(&r, "payee_mismatch"));
}

#[test]
fn attack_ai_fooled_into_writing_the_attackers_address_is_seized() {
    let mut c = setup();
    // Even if the real supplier's key signed it (e.g. the AI was fooled upstream and
    // the supplier's own system was tricked), money can only go to the registered route.
    let r = submit(
        &mut c,
        invoice("INV-2210", 100, 780, 78_000, "qingmar-payments.testnet"),
        delivery("DN-552", 100),
        1,
    );
    assert_eq!(r.verdict, Verdict::Seized);
    assert!(has(&r, "payee_mismatch"));
}

#[test]
fn attack_invoice_edited_after_the_supplier_signed_it_is_seized() {
    let mut c = setup();
    let signed = invoice("INV-1", 100, 780, 78_000, "qingmar.testnet");
    let s1 = sign_invoice(&key(SUPPLIER), &signed);
    let note = delivery("DN-1", 100);
    let s2 = sign_delivery(&key(STOREKEEPER), &note);
    let mut edited = signed.clone();
    edited.invoice_number = "INV-1-copy".into();
    ctx(owner(), LIVE, 0);
    let r = c.submit_invoice(edited, s1, note, pk(&key(STOREKEEPER)), s2, doc(1));
    assert_eq!(r.verdict, Verdict::Seized);
    assert!(has(&r, "invalid_supplier_signature"));
}

#[test]
fn attack_paying_the_same_invoice_twice_is_seized() {
    let mut c = setup();
    let first = submit(
        &mut c,
        invoice("INV-2208", 50, 780, 39_000, "qingmar.testnet"),
        delivery("DN-1", 50),
        1,
    );
    assert_eq!(first.verdict, Verdict::Cleared);
    let again = submit(
        &mut c,
        invoice("INV-2208", 50, 780, 39_000, "qingmar.testnet"),
        delivery("DN-2", 50),
        2,
    );
    assert_eq!(again.verdict, Verdict::Seized);
    assert!(has(&again, "duplicate_invoice"));
}

#[test]
fn attack_renumbered_copy_of_a_paid_document_is_seized() {
    let mut c = setup();
    let first = submit(
        &mut c,
        invoice("LC-0918", 50, 780, 39_000, "qingmar.testnet"),
        delivery("DN-1", 50),
        7,
    );
    assert_eq!(first.verdict, Verdict::Cleared);
    // Same PDF (same fingerprint), new invoice number.
    let copy = submit(
        &mut c,
        invoice("LC-0931", 50, 780, 39_000, "qingmar.testnet"),
        delivery("DN-2", 50),
        7,
    );
    assert_eq!(copy.verdict, Verdict::Seized);
    assert!(has(&copy, "duplicate_document"));
}

#[test]
fn attack_reusing_one_delivery_for_two_invoices_is_seized() {
    let mut c = setup();
    let a = submit(
        &mut c,
        invoice("INV-1", 50, 780, 39_000, "qingmar.testnet"),
        delivery("DN-1", 50),
        1,
    );
    assert_eq!(a.verdict, Verdict::Cleared);
    let b = submit(
        &mut c,
        invoice("INV-2", 50, 780, 39_000, "qingmar.testnet"),
        delivery("DN-1", 50),
        2,
    );
    assert_eq!(b.verdict, Verdict::Seized);
    assert!(has(&b, "delivery_note_reused"));
}

#[test]
fn a_forged_copy_cannot_block_the_real_invoice() {
    let mut c = setup();
    // An attacker's fake "INV-2208" is seized first...
    let inv = invoice("INV-2208", 100, 780, 78_000, "attacker.testnet");
    let note = delivery("DN-552", 100);
    let s1 = sign_invoice(&key(66), &inv);
    let s2 = sign_delivery(&key(STOREKEEPER), &note);
    ctx(owner(), LIVE, 0);
    let fake = c.submit_invoice(inv, s1, note, pk(&key(STOREKEEPER)), s2, doc(9));
    assert_eq!(fake.verdict, Verdict::Seized);
    // ...and the real INV-2208 from the real supplier still clears.
    let real = submit(
        &mut c,
        invoice("INV-2208", 100, 780, 78_000, "qingmar.testnet"),
        delivery("DN-552", 100),
        1,
    );
    assert_eq!(
        real.verdict,
        Verdict::Cleared,
        "reasons: {:?}",
        real.reasons
    );
}

#[test]
fn attack_huge_quantities_cannot_overflow_the_total() {
    let mut c = setup();
    let mut inv = invoice("INV-1", u64::MAX, 780, 1, "qingmar.testnet");
    inv.lines[0].unit_price = U128(u128::MAX);
    let r = submit(&mut c, inv, delivery("DN-1", u64::MAX), 1);
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "arithmetic_overflow"));
}

// ---------------------------------------------------------------------- who may call what

#[test]
#[should_panic(expected = "only the buyer's agent can submit invoices")]
fn strangers_cannot_submit_invoices() {
    let mut c = setup();
    let inv = invoice("INV-1", 100, 780, 78_000, "qingmar.testnet");
    let note = delivery("DN-1", 100);
    let s1 = sign_invoice(&key(SUPPLIER), &inv);
    let s2 = sign_delivery(&key(STOREKEEPER), &note);
    ctx("stranger.testnet".parse().unwrap(), LIVE, 0);
    c.submit_invoice(inv, s1, note, pk(&key(STOREKEEPER)), s2, doc(1));
}

#[test]
#[should_panic(expected = "contract is paused")]
fn paused_contract_inspects_nothing() {
    let mut c = setup();
    ctx(owner(), LIVE, 1);
    c.pause();
    submit(
        &mut c,
        invoice("INV-1", 100, 780, 78_000, "qingmar.testnet"),
        delivery("DN-1", 100),
        1,
    );
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn the_agent_key_cannot_create_orders() {
    let mut c = setup();
    ctx(owner(), LIVE, 0); // a function-call key cannot attach the 1 yocto
    c.create_order(
        "PO-9".into(),
        "qingmar-steel".into(),
        USDC.into(),
        vec![OrderLine {
            sku: "X".into(),
            qty: U64(1),
            unit_price: U128(1),
        }],
    );
}

#[test]
#[should_panic(expected = "per-invoice limit cannot exceed the period limit")]
fn limits_must_be_consistent() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.set_limits(U128(10), U128(5), U64(24));
}
