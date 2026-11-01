//! The second delivery signature (two-person rule), after public criticism:
//! "trust just moved to whoever signs the delivery receipt". One key alone can no
//! longer confirm a delivery. Each case below is one rule from the third security
//! review's list for this design.

use super::inspection::*;
use super::test_support::{STOREKEEPER_SEED, WEIGHBRIDGE_SEED, pubkey, sign_as, two_signatures};
use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{NearToken, testing_env};

const HOUR: u64 = 3_600_000_000_000;
const T0: u64 = 1_800_000_000 * 1_000_000_000;
const LIVE: u64 = T0 + 100 * HOUR;
const UNIT: u128 = 1_000_000;
const SUPPLIER: u8 = 7;
const INSPECTOR: u8 = 23;
const SECOND_STOREKEEPER: u8 = 24;

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
fn route() -> PayoutRoute {
    PayoutRoute {
        chain: "near".into(),
        token: "usdc.testnet".into(),
        address: "qingmar.testnet".into(),
    }
}
fn order_line() -> Vec<OrderLine> {
    vec![OrderLine {
        sku: "AH36-12mm".into(),
        qty: U64(100),
        unit_price: U128(780 * UNIT),
    }]
}

/// Supplier, a storekeeper and a weighbridge, two orders, limits.
fn setup() -> Contract {
    ctx(owner(), T0, 0);
    let mut c = Contract::new(owner());
    ctx(owner(), T0, 1);
    c.register_supplier("qingmar-steel".into(), pubkey(SUPPLIER), route());
    ctx(owner(), T0, 1);
    c.add_storekeeper(pubkey(STOREKEEPER_SEED));
    ctx(owner(), T0, 1);
    c.add_delivery_signer(pubkey(WEIGHBRIDGE_SEED), "weighbridge".into());
    for id in ["PO-1184", "PO-2000"] {
        ctx(owner(), T0, 1);
        c.create_order(
            id.into(),
            "qingmar-steel".into(),
            "usdc.testnet".into(),
            order_line(),
        );
    }
    ctx(owner(), T0, 1);
    c.set_limits(U128(100_000 * UNIT), U128(250_000 * UNIT), U64(720), 100);
    c
}
fn note(order: &str, id: &str) -> DeliveryNote {
    DeliveryNote {
        order_id: order.into(),
        note_id: id.into(),
        lines: vec![DeliveredLine {
            sku: "AH36-12mm".into(),
            qty: U64(10),
        }],
    }
}
fn submit_for(
    c: &mut Contract,
    order: &str,
    number: &str,
    n: DeliveryNote,
    sigs: Vec<DeliverySignature>,
) -> InspectionResult {
    let inv = Invoice {
        supplier_id: "qingmar-steel".into(),
        invoice_number: number.into(),
        order_id: order.into(),
        token: "usdc.testnet".into(),
        lines: vec![InvoiceLine {
            sku: "AH36-12mm".into(),
            qty: U64(10),
            unit_price: U128(780 * UNIT),
        }],
        total: U128(7_800 * UNIT),
        payee: route(),
    };
    let doc = env::sha256_array(number.as_bytes());
    let d = InvoiceMessage {
        domain: INVOICE_DOMAIN.into(),
        contract: contract_id(),
        invoice: inv.clone(),
        document_hash: doc,
    }
    .digest();
    let sig = SigningKey::from_bytes(&[SUPPLIER; 32]).sign(&d);
    ctx(owner(), LIVE, 0);
    c.submit_invoice(
        inv,
        Base64VecU8(sig.to_bytes().to_vec()),
        n,
        sigs,
        Base64VecU8(doc.to_vec()),
    )
}
fn submit(c: &mut Contract, n: DeliveryNote, sigs: Vec<DeliverySignature>) -> InspectionResult {
    submit_for(c, "PO-1184", "INV-1", n, sigs)
}
fn has(r: &InspectionResult, code: &str) -> bool {
    r.reasons.iter().any(|x| x == code)
}
fn sk(n: &DeliveryNote) -> DeliverySignature {
    sign_as(STOREKEEPER_SEED, "storekeeper", n, &contract_id(), 0)
}
fn wb(n: &DeliveryNote) -> DeliverySignature {
    sign_as(WEIGHBRIDGE_SEED, "weighbridge", n, &contract_id(), 0)
}

#[test]
fn control_storekeeper_and_weighbridge_together_clear() {
    let mut c = setup();
    let n = note("PO-1184", "DN-1");
    let r = submit(&mut c, n.clone(), two_signatures(&n, &contract_id()));
    assert_eq!(r.verdict, Verdict::Cleared, "{:?}", r.reasons);
}

#[test]
fn one_signature_alone_is_held() {
    let mut c = setup();
    let n = note("PO-1184", "DN-1");
    for sigs in [vec![sk(&n)], vec![wb(&n)], vec![]] {
        let r = submit(&mut c, n.clone(), sigs);
        assert_eq!(r.verdict, Verdict::Held);
        assert!(has(&r, "delivery_signatures_missing"), "{:?}", r.reasons);
    }
}

#[test]
#[should_panic(expected = "storekeeper already registered")]
fn same_key_cannot_be_registered_for_two_roles() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.add_delivery_signer(pubkey(STOREKEEPER_SEED), "inspector".into());
}

#[test]
fn same_signer_twice_does_not_count_twice() {
    let mut c = setup();
    let n = note("PO-1184", "DN-1");
    let r = submit(&mut c, n.clone(), vec![sk(&n), sk(&n)]);
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "duplicate_delivery_signer"));
    assert!(has(&r, "delivery_signatures_missing"));
}

#[test]
fn signatures_for_one_order_do_not_work_for_another() {
    let mut c = setup();
    let signed = note("PO-1184", "DN-1");
    let sigs = two_signatures(&signed, &contract_id());
    // Same note id, other order: the order id is inside what was signed.
    let r = submit_for(&mut c, "PO-2000", "INV-9", note("PO-2000", "DN-1"), sigs);
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "invalid_delivery_signature"));
}

#[test]
fn signatures_from_two_different_notes_cannot_be_mixed() {
    let mut c = setup();
    let n1 = note("PO-1184", "DN-1");
    let n2 = note("PO-1184", "DN-2");
    let r = submit(&mut c, n1.clone(), vec![sk(&n1), wb(&n2)]);
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "invalid_delivery_signature"));
    assert!(has(&r, "delivery_signatures_missing"));
}

#[test]
fn signatures_made_under_an_old_policy_stop_counting() {
    let mut c = setup();
    let n = note("PO-1184", "DN-1");
    let old = two_signatures(&n, &contract_id()); // policy version 0
    ctx(owner(), T0, 1);
    c.set_delivery_policy("PO-1184".into(), 2, vec![]);
    assert_eq!(c.get_delivery_policy("PO-1184".into()).version, 1);
    let r = submit(&mut c, n.clone(), old);
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "invalid_delivery_signature"));
    // Re-signed under the new version, the same delivery clears.
    let new = vec![
        sign_as(STOREKEEPER_SEED, "storekeeper", &n, &contract_id(), 1),
        sign_as(WEIGHBRIDGE_SEED, "weighbridge", &n, &contract_id(), 1),
    ];
    let r = submit(&mut c, n, new);
    assert_eq!(r.verdict, Verdict::Cleared, "{:?}", r.reasons);
}

#[test]
fn a_removed_signer_no_longer_counts_even_for_signatures_made_before() {
    let mut c = setup();
    let n = note("PO-1184", "DN-1");
    let sigs = two_signatures(&n, &contract_id()); // signed while both were registered
    ctx(owner(), T0, 1);
    c.remove_storekeeper(pubkey(WEIGHBRIDGE_SEED));
    let r = submit(&mut c, n, sigs);
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "unknown_storekeeper"));
    assert!(has(&r, "delivery_signatures_missing"));
}

#[test]
fn a_re_registered_key_cannot_reuse_signatures_from_its_old_role() {
    let mut c = setup();
    let n = note("PO-1184", "DN-1");
    let sigs = two_signatures(&n, &contract_id());
    ctx(owner(), T0, 1);
    c.remove_storekeeper(pubkey(WEIGHBRIDGE_SEED));
    ctx(owner(), T0, 1);
    c.add_delivery_signer(pubkey(WEIGHBRIDGE_SEED), "inspector".into());
    let r = submit(&mut c, n, sigs);
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "invalid_delivery_signature"));
}

#[test]
fn the_suppliers_own_key_cannot_sign_the_delivery() {
    let mut c = setup();
    let n = note("PO-1184", "DN-1");
    let supplier_sig = sign_as(SUPPLIER, "weighbridge", &n, &contract_id(), 0);
    let r = submit(&mut c, n.clone(), vec![sk(&n), supplier_sig]);
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "storekeeper_is_supplier"));
    assert!(has(&r, "delivery_signatures_missing"));
}

#[test]
#[should_panic(expected = "supplier and storekeeper keys must differ")]
fn the_suppliers_key_cannot_be_registered_as_a_delivery_signer() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.add_delivery_signer(pubkey(SUPPLIER), "weighbridge".into());
}

#[test]
fn one_valid_and_one_invalid_signature_do_not_make_two() {
    let mut c = setup();
    let n = note("PO-1184", "DN-1");
    let mut bad = wb(&n);
    bad.signature.0[0] ^= 1;
    let r = submit(&mut c, n.clone(), vec![sk(&n), bad]);
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "invalid_delivery_signature"));
}

#[test]
fn two_of_three_needs_two_different_allowed_roles() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.add_delivery_signer(pubkey(INSPECTOR), "inspector".into());
    ctx(owner(), T0, 1);
    c.add_storekeeper(pubkey(SECOND_STOREKEEPER));
    ctx(owner(), T0, 1);
    c.set_delivery_policy(
        "PO-1184".into(),
        2,
        vec![
            "storekeeper".into(),
            "weighbridge".into(),
            "inspector".into(),
        ],
    );
    let n = note("PO-1184", "DN-1");
    let s = |seed, role: &str| sign_as(seed, role, &n, &contract_id(), 1);
    // Two storekeepers are one role.
    let r = submit(
        &mut c,
        n.clone(),
        vec![
            s(STOREKEEPER_SEED, "storekeeper"),
            s(SECOND_STOREKEEPER, "storekeeper"),
        ],
    );
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "duplicate_delivery_role"));
    // Storekeeper and inspector: two roles, both allowed.
    let r = submit(
        &mut c,
        n.clone(),
        vec![
            s(STOREKEEPER_SEED, "storekeeper"),
            s(INSPECTOR, "inspector"),
        ],
    );
    assert_eq!(r.verdict, Verdict::Cleared, "{:?}", r.reasons);
}

#[test]
fn a_role_the_order_does_not_allow_does_not_count() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.add_delivery_signer(pubkey(INSPECTOR), "inspector".into());
    ctx(owner(), T0, 1);
    c.set_delivery_policy(
        "PO-1184".into(),
        2,
        vec!["storekeeper".into(), "weighbridge".into()],
    );
    let n = note("PO-1184", "DN-1");
    let r = submit(
        &mut c,
        n.clone(),
        vec![
            sign_as(STOREKEEPER_SEED, "storekeeper", &n, &contract_id(), 1),
            sign_as(INSPECTOR, "inspector", &n, &contract_id(), 1),
        ],
    );
    assert_eq!(r.verdict, Verdict::Held);
    assert!(has(&r, "delivery_signer_role_not_allowed"));
    assert!(has(&r, "delivery_signatures_missing"));
}

#[test]
fn a_delivery_note_already_used_cannot_clear_a_second_invoice() {
    let mut c = setup();
    let n = note("PO-1184", "DN-1");
    let r = submit(&mut c, n.clone(), two_signatures(&n, &contract_id()));
    assert_eq!(r.verdict, Verdict::Cleared, "{:?}", r.reasons);
    let r = submit_for(
        &mut c,
        "PO-1184",
        "INV-2",
        n.clone(),
        two_signatures(&n, &contract_id()),
    );
    assert_eq!(r.verdict, Verdict::Seized);
    assert!(has(&r, "delivery_note_reused"));
}

#[test]
#[should_panic(expected = "at most 5 delivery signatures")]
fn more_than_five_signatures_are_refused() {
    let mut c = setup();
    let n = note("PO-1184", "DN-1");
    submit(&mut c, n.clone(), vec![sk(&n); 6]);
}

#[test]
fn policy_rules_are_checked_when_set() {
    let bad: Vec<(u8, Vec<&str>, &str)> = vec![
        (0, vec![], "required signatures must be 1 to 5"),
        (6, vec![], "required signatures must be 1 to 5"),
        (
            3,
            vec!["storekeeper", "weighbridge"],
            "more signatures required than roles allowed",
        ),
        (
            2,
            vec!["storekeeper", "storekeeper"],
            "a role is listed twice",
        ),
        (
            2,
            vec!["Weigh Bridge", "storekeeper"],
            "role must be 1 to 32 characters",
        ),
    ];
    for (required, roles, msg) in bad {
        let roles: Vec<String> = roles.into_iter().map(String::from).collect();
        let msg = msg.to_string();
        std::thread::spawn(move || {
            let mut c = setup();
            ctx(owner(), T0, 1);
            let e = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                c.set_delivery_policy("PO-1184".into(), required, roles)
            }))
            .expect_err("must be refused");
            let text = e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            assert!(text.contains(&msg), "expected {msg:?}, got {text:?}");
        })
        .join()
        .expect("case passed");
    }
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_the_buyer_sets_a_delivery_policy() {
    let mut c = setup();
    ctx("stranger.testnet".parse().unwrap(), T0, 1);
    c.set_delivery_policy("PO-1184".into(), 1, vec![]);
}

#[test]
fn existing_storekeepers_keep_their_role_without_migration() {
    let c = setup();
    let signers = c.get_delivery_signers();
    let role_of = |k: &PublicKey| signers.iter().find(|s| &s.key == k).map(|s| s.role.clone());
    assert_eq!(
        role_of(&pubkey(STOREKEEPER_SEED)).as_deref(),
        Some("storekeeper")
    );
    assert_eq!(
        role_of(&pubkey(WEIGHBRIDGE_SEED)).as_deref(),
        Some("weighbridge")
    );
    let p = c.get_delivery_policy("PO-1184".into());
    assert_eq!((p.required, p.version), (2, 0));
}

/// Attack demo, part 2 (run with --nocapture to see the log): the AI was fooled anyway
/// and wrote the attacker's address into the invoice. The contract decides, not the AI.
#[test]
fn demo_a_fooled_agent_is_stopped_by_the_contract() {
    let mut c = setup();
    let attacker = "qingmar-payments.testnet";
    let n = note("PO-1184", "DN-552");
    eprintln!("[agent]    read the poisoned invoice and believed it: pay {attacker}");
    let mut inv = Invoice {
        supplier_id: "qingmar-steel".into(),
        invoice_number: "INV-2210".into(),
        order_id: "PO-1184".into(),
        token: "usdc.testnet".into(),
        lines: vec![InvoiceLine {
            sku: "AH36-12mm".into(),
            qty: U64(10),
            unit_price: U128(780 * UNIT),
        }],
        total: U128(7_800 * UNIT),
        payee: route(),
    };
    inv.payee.address = attacker.into();
    let doc = env::sha256_array(b"INV-2210 poisoned");
    let d = InvoiceMessage {
        domain: INVOICE_DOMAIN.into(),
        contract: contract_id(),
        invoice: inv.clone(),
        document_hash: doc,
    }
    .digest();
    let sig = SigningKey::from_bytes(&[SUPPLIER; 32]).sign(&d);
    eprintln!(
        "[agent]    submit_invoice(INV-2210, payee = {attacker}), signed by the supplier, delivery signed by two roles"
    );
    ctx(owner(), LIVE, 0);
    let r = c.submit_invoice(
        inv,
        Base64VecU8(sig.to_bytes().to_vec()),
        n.clone(),
        two_signatures(&n, &contract_id()),
        Base64VecU8(doc.to_vec()),
    );
    eprintln!("[contract] registered address for qingmar-steel: qingmar.testnet");
    eprintln!("[contract] verdict: {:?} {:?}", r.verdict, r.reasons);
    eprintln!("[contract] payment created: {:?}", r.payment);
    assert_eq!(r.verdict, Verdict::Seized);
    assert!(has(&r, "payee_mismatch"));
    assert_eq!(r.payment, None);
    eprintln!("[result]   STOPPED by the contract: nothing paid, the document can never be paid");
}
