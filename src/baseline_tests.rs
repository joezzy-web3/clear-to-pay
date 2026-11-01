//! Baseline comparison: the usual agent-spending guard ("allowlist + limits") against
//! Clear to Pay, on the same invoice attacks.
//!
//! The baseline is what most agent-payment firewalls do: the agent may pay any address on
//! an allowlist (here: every supplier's registered address), up to a per-payment limit and
//! a per-period limit. It is given the same limits as the contract. Each scenario runs
//! through both on a fresh contract. Run with --nocapture to print the table
//! (`scripts/baseline.sh` does that and saves it).
//!
//! Honest scope: the baseline needs no supplier keys or delivery signers, so it is
//! cheaper to set up. Where it blocks an attack, the table says so.

use super::inspection::*;
use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{NearToken, testing_env};
use std::collections::HashSet;

const HOUR: u64 = 3_600_000_000_000;
const T0: u64 = 1_800_000_000 * 1_000_000_000;
const LIVE: u64 = T0 + 100 * HOUR;
const USDC: &str = "usdc.testnet";
const UNIT: u128 = 1_000_000;
const SUPPLIER: u8 = 7;
const OTHER_SUPPLIER: u8 = 8;
const STOREKEEPER: u8 = 21;
const WEIGHBRIDGE: u8 = 22;
const PER_INVOICE: u128 = 100_000 * UNIT;
const PER_PERIOD: u128 = 250_000 * UNIT;

// ---------------------------------------------------------------------- the baseline

struct Baseline {
    allowlist: HashSet<String>,
    spent: u128,
}

impl Baseline {
    fn new() -> Self {
        Self {
            allowlist: ["qingmar.testnet", "lagoscement.testnet"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            spent: 0,
        }
    }
    fn pay(&mut self, inv: &Invoice) -> Result<(), &'static str> {
        let amount = inv.total.0;
        if !self.allowlist.contains(&inv.payee.address) {
            return Err("payee not on allowlist");
        }
        if amount > PER_INVOICE {
            return Err("over per-payment limit");
        }
        if self.spent + amount > PER_PERIOD {
            return Err("over period limit");
        }
        self.spent += amount;
        Ok(())
    }
}

// ---------------------------------------------------------------------- the contract side

fn owner() -> AccountId {
    "buyer.testnet".parse().unwrap()
}
fn contract_id() -> AccountId {
    "cleartopay.testnet".parse().unwrap()
}
fn ctx(at: u64, yocto: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(owner())
        .signer_account_id(owner())
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
fn setup() -> Contract {
    ctx(T0, 0);
    let mut c = Contract::new(owner());
    ctx(T0, 1);
    c.register_supplier(
        "qingmar-steel".into(),
        pk(&key(SUPPLIER)),
        route("qingmar.testnet"),
    );
    ctx(T0, 1);
    c.register_supplier(
        "lagos-cement".into(),
        pk(&key(OTHER_SUPPLIER)),
        route("lagoscement.testnet"),
    );
    ctx(T0, 1);
    c.add_storekeeper(pk(&key(STOREKEEPER)));
    ctx(T0, 1);
    c.add_delivery_signer(pk(&key(WEIGHBRIDGE)), "weighbridge".into());
    ctx(T0, 1);
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
    ctx(T0, 1);
    c.set_limits(U128(PER_INVOICE), U128(PER_PERIOD), U64(720), 100);
    c
}
fn invoice(number: &str, qty: u64, price: u128, payee: &str) -> Invoice {
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
        total: U128(qty as u128 * price * UNIT),
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
fn sign_invoice(k: &SigningKey, inv: &Invoice, document: u8) -> Base64VecU8 {
    let d = InvoiceMessage {
        domain: INVOICE_DOMAIN.into(),
        contract: contract_id(),
        invoice: inv.clone(),
        document_hash: [document; 32],
    }
    .digest();
    Base64VecU8(k.sign(&d).to_bytes().to_vec())
}
fn sign_as(k: &SigningKey, role: &str, n: &DeliveryNote) -> DeliverySignature {
    let d = DeliverySignerMessage {
        domain: DELIVERY_SIGNER_DOMAIN.into(),
        contract: contract_id(),
        note: n.clone(),
        role: role.into(),
        policy_version: 0,
    }
    .digest();
    DeliverySignature {
        key: pk(k),
        signature: Base64VecU8(k.sign(&d).to_bytes().to_vec()),
    }
}
fn both_roles(n: &DeliveryNote) -> Vec<DeliverySignature> {
    vec![
        sign_as(&key(STOREKEEPER), "storekeeper", n),
        sign_as(&key(WEIGHBRIDGE), "weighbridge", n),
    ]
}

/// One submission: what the baseline does with it, and what the contract does with it.
struct Step {
    inv: Invoice,
    signed: Option<Invoice>, // what the supplier actually signed, if different
    note: DeliveryNote,
    sigs: Vec<DeliverySignature>,
    document: u8,
}
fn step(inv: Invoice, note: DeliveryNote, document: u8) -> Step {
    let sigs = both_roles(&note);
    Step {
        inv,
        signed: None,
        note,
        sigs,
        document,
    }
}

struct Outcome {
    baseline_paid: bool,
    baseline: String,
    ctp_paid: bool,
    ctp: String,
}

/// Runs the steps through both, on a fresh contract (own thread = own mocked chain).
/// The last step is the attack; earlier steps set the scene.
fn run(base: Baseline, steps: Vec<Step>) -> Outcome {
    std::thread::spawn(move || run_here(base, steps))
        .join()
        .unwrap()
}
fn run_here(mut base: Baseline, steps: Vec<Step>) -> Outcome {
    let mut c = setup();
    let mut last = None;
    for (i, s) in steps.into_iter().enumerate() {
        let b = base.pay(&s.inv);
        let sig = sign_invoice(
            &key(SUPPLIER),
            s.signed.as_ref().unwrap_or(&s.inv),
            s.document,
        );
        ctx(LIVE + i as u64 * HOUR, 0);
        let r = c.submit_invoice(
            s.inv,
            sig,
            s.note,
            s.sigs,
            Base64VecU8(vec![s.document; 32]),
        );
        last = Some((b, r));
    }
    let (b, r) = last.unwrap();
    Outcome {
        baseline_paid: b.is_ok(),
        baseline: match b {
            Ok(()) => "**PAID**".into(),
            Err(e) => format!("blocked ({e})"),
        },
        ctp_paid: r.verdict == Verdict::Cleared,
        ctp: if r.verdict == Verdict::Cleared {
            "**PAID**".into()
        } else {
            format!(
                "{} (`{}`)",
                format!("{:?}", r.verdict).to_uppercase(),
                r.reasons.join("`, `")
            )
        },
    }
}

fn honest() -> Step {
    step(
        invoice("INV-2208", 10, 780, "qingmar.testnet"),
        delivery("DN-552", 10),
        1,
    )
}

#[test]
fn baseline_comparison_allowlist_and_limits_versus_clear_to_pay() {
    let mut rows: Vec<(&str, Outcome, bool)> = Vec::new(); // (attack, outcome, baseline expected to pay)

    rows.push((
        "Honest invoice: 10 t delivered, 10 t billed (control)",
        run(Baseline::new(), vec![honest()]),
        true,
    ));

    rows.push((
        "\"Bank details changed\": pay the attacker's new address",
        run(
            Baseline::new(),
            vec![step(
                invoice("INV-2210", 10, 780, "qingmar-payments.testnet"),
                delivery("DN-552", 10),
                1,
            )],
        ),
        false,
    ));

    let mut fooled_ops = Baseline::new();
    fooled_ops
        .allowlist
        .insert("qingmar-payments.testnet".into()); // ops trusted the email and updated the list
    rows.push((
        "Same email, and someone adds the new address to the allowlist",
        run(
            fooled_ops,
            vec![step(
                invoice("INV-2210", 10, 780, "qingmar-payments.testnet"),
                delivery("DN-552", 10),
                1,
            )],
        ),
        true,
    ));

    rows.push((
        "AI fooled into paying another supplier's address (on the allowlist)",
        run(
            Baseline::new(),
            vec![step(
                invoice("INV-2210", 10, 780, "lagoscement.testnet"),
                delivery("DN-552", 10),
                1,
            )],
        ),
        true,
    ));

    rows.push((
        "Over-billing: 10 t delivered, 12 t billed",
        run(
            Baseline::new(),
            vec![step(
                invoice("INV-2211", 12, 780, "qingmar.testnet"),
                delivery("DN-553", 10),
                1,
            )],
        ),
        true,
    ));

    rows.push((
        "Price raised above the order: 900 instead of 780 per t",
        run(
            Baseline::new(),
            vec![step(
                invoice("INV-2212", 10, 900, "qingmar.testnet"),
                delivery("DN-554", 10),
                1,
            )],
        ),
        true,
    ));

    let mut one_signer = step(
        invoice("INV-2213", 10, 780, "qingmar.testnet"),
        delivery("DN-555", 10),
        1,
    );
    one_signer.sigs.truncate(1); // only the storekeeper "confirms" the delivery
    rows.push((
        "Delivery confirmed by one insider only (no second role)",
        run(Baseline::new(), vec![one_signer]),
        true,
    ));

    rows.push((
        "Same invoice paid twice",
        run(
            Baseline::new(),
            vec![
                honest(),
                step(
                    invoice("INV-2208", 10, 780, "qingmar.testnet"),
                    delivery("DN-556", 10),
                    2,
                ),
            ],
        ),
        true,
    ));

    rows.push((
        "Same document, new invoice number",
        run(
            Baseline::new(),
            vec![
                honest(),
                step(
                    invoice("INV-2208-B", 10, 780, "qingmar.testnet"),
                    delivery("DN-557", 10),
                    1,
                ),
            ],
        ),
        true,
    ));

    rows.push((
        "One delivery note used for two invoices",
        run(
            Baseline::new(),
            vec![
                honest(),
                step(
                    invoice("INV-2214", 10, 780, "qingmar.testnet"),
                    delivery("DN-552", 10),
                    3,
                ),
            ],
        ),
        true,
    ));

    let mut edited = step(
        invoice("INV-2215", 10, 780, "qingmar.testnet"),
        delivery("DN-558", 11),
        1,
    );
    edited.signed = Some(edited.inv.clone());
    edited.inv.lines[0].qty = U64(11);
    edited.inv.total = U128(11 * 780 * UNIT); // changed after the supplier signed
    rows.push((
        "Invoice edited after the supplier signed it",
        run(Baseline::new(), vec![edited]),
        true,
    ));

    rows.push((
        "Over the per-payment limit (both have the same limits)",
        run(
            Baseline::new(),
            vec![step(
                invoice("INV-2216", 200, 780, "qingmar.testnet"),
                delivery("DN-559", 200),
                1,
            )],
        ),
        false,
    ));

    eprintln!("| Attack | Allowlist + limits | Clear to Pay |");
    eprintln!("|---|---|---|");
    let (mut base_paid, mut ctp_paid) = (0, 0);
    for (name, o, base_expected) in &rows[1..] {
        eprintln!("| {name} | {} | {} |", o.baseline, o.ctp);
        assert_eq!(o.baseline_paid, *base_expected, "baseline on: {name}");
        assert!(!o.ctp_paid, "Clear to Pay paid: {name}");
        base_paid += o.baseline_paid as u32;
        ctp_paid += o.ctp_paid as u32;
    }
    let (name, control, _) = &rows[0];
    eprintln!("| {name} | {} | {} |", control.baseline, control.ctp);
    assert!(
        control.baseline_paid && control.ctp_paid,
        "the honest invoice must be paid by both"
    );
    let attacks = rows.len() - 1;
    eprintln!();
    eprintln!(
        "Attacks paid: allowlist + limits {base_paid} of {attacks}; Clear to Pay {ctp_paid} of {attacks}. Honest invoice paid by both."
    );
}
