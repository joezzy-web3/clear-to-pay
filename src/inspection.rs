//! Inspection: the agent submits an invoice, the contract stamps it.
//!
//! The AI's job ends before this code runs. What arrives here is a structured
//! invoice plus two signatures:
//! - the supplier's, proving the supplier issued exactly this invoice;
//! - two or more delivery signers' (storekeeper, weighbridge, inspector...),
//!   proving what was actually delivered. One key alone cannot confirm a delivery.
//!
//! The contract checks them against data the AI never touched: the buyer's
//! purchase order, the supplier registry and the limits. It returns one of
//! three verdicts and always writes a receipt.
//!
//! - CLEARED: everything agrees. (Payment is added in the next step.)
//! - HELD: something does not add up; nothing is recorded as used, so a
//!   corrected invoice can be submitted again.
//! - SEIZED: the invoice tries to send money somewhere it must not go, is forged,
//!   or repeats something already used.

use crate::*;
use near_sdk::json_types::U128;

pub const INVOICE_DOMAIN: &str = "clear-to-pay/invoice/v1";
/// Domain of the delivery note's fingerprint (stored on the receipt). Not signed on its own.
pub const DELIVERY_DOMAIN: &str = "clear-to-pay/delivery/v1";
/// What each delivery signer signs: the note, plus its own role and the order's policy version.
pub const DELIVERY_SIGNER_DOMAIN: &str = "clear-to-pay/delivery/v2";
const MAX_LINES: usize = 50;
pub const MAX_DELIVERY_SIGNATURES: usize = 5;
/// Distinct roles that must sign a delivery when the buyer has set no policy for the order.
pub const DEFAULT_REQUIRED_DELIVERY_SIGNATURES: u8 = 2;
const DEFAULT_ROLE: &str = "storekeeper";

// ---------------------------------------------------------------------- types

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderLine {
    pub sku: String,
    pub qty: U64,
    /// Price per unit in the token's smallest unit.
    pub unit_price: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Order {
    pub supplier_id: String,
    pub token: String,
    pub lines: Vec<OrderLine>,
    /// Quantity already invoiced and cleared, per line, in the same order as `lines`.
    pub invoiced: Vec<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvoiceLine {
    pub sku: String,
    pub qty: U64,
    pub unit_price: U128,
}

/// The structured invoice the agent submits, exactly as the supplier signed it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invoice {
    pub supplier_id: String,
    pub invoice_number: String,
    pub order_id: String,
    pub token: String,
    pub lines: Vec<InvoiceLine>,
    pub total: U128,
    /// Where the invoice asks to be paid. Only ever compared, never trusted.
    pub payee: PayoutRoute,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveredLine {
    pub sku: String,
    pub qty: U64,
}

/// What actually arrived, signed by a storekeeper the buyer registered.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryNote {
    pub order_id: String,
    pub note_id: String,
    pub lines: Vec<DeliveredLine>,
}

#[near(serializers = [borsh])]
pub struct InvoiceMessage {
    pub domain: String,
    pub contract: AccountId,
    pub invoice: Invoice,
    /// sha-256 of the original document. Signed by the supplier, so the
    /// fingerprint cannot be swapped or attached to someone else's invoice.
    pub document_hash: [u8; 32],
}

/// The delivery note's fingerprint, recorded on every receipt.
#[near(serializers = [borsh])]
pub struct DeliveryMessage {
    pub domain: String,
    pub contract: AccountId,
    pub note: DeliveryNote,
}

/// What one delivery signer signs. The role and the policy version are inside the
/// signature, so a signature cannot be reused under another role, and signatures made
/// under an older policy for the order stop counting when the policy changes.
#[near(serializers = [borsh])]
pub struct DeliverySignerMessage {
    pub domain: String,
    pub contract: AccountId,
    pub note: DeliveryNote,
    pub role: String,
    pub policy_version: u32,
}

/// One delivery signer's signature, as the agent submits it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct DeliverySignature {
    pub key: PublicKey,
    pub signature: Base64VecU8,
}

/// How many distinct roles must sign a delivery for an order, and which roles count.
/// An empty `roles` list means any registered role counts.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryPolicy {
    pub required: u8,
    pub roles: Vec<String>,
    /// 0 until the buyer sets a policy; +1 on every change.
    pub version: u32,
}

/// A registered delivery signer and its one role.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DeliverySigner {
    pub key: PublicKey,
    pub role: String,
}

// Kept under their own storage keys (not fields of `Contract`), so adding them did not
// change the contract's stored layout.
fn role_key(key: &PublicKey) -> Vec<u8> {
    let mut k = b"signer_role:".to_vec();
    k.extend_from_slice(key.as_bytes());
    k
}
fn policy_key(order_id: &str) -> Vec<u8> {
    let mut k = b"delivery_policy:".to_vec();
    k.extend_from_slice(order_id.as_bytes());
    k
}
/// A signer's role. Storekeepers registered before roles existed are "storekeeper".
pub(crate) fn signer_role(key: &PublicKey) -> String {
    env::storage_read(&role_key(key))
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_else(|| DEFAULT_ROLE.to_string())
}
pub(crate) fn delivery_policy(order_id: &str) -> DeliveryPolicy {
    env::storage_read(&policy_key(order_id))
        .map(|b| near_sdk::borsh::from_slice(&b).expect("policy record is valid"))
        .unwrap_or(DeliveryPolicy {
            required: DEFAULT_REQUIRED_DELIVERY_SIGNATURES,
            roles: Vec::new(),
            version: 0,
        })
}
fn validate_role(role: &str) {
    require!(
        !role.is_empty()
            && role.len() <= 32
            && role
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
        "role must be 1 to 32 characters of a-z, 0-9, '-'"
    );
}

impl InvoiceMessage {
    pub fn digest(&self) -> [u8; 32] {
        env::sha256_array(near_sdk::borsh::to_vec(self).expect("encodes"))
    }
}
impl DeliveryMessage {
    pub fn digest(&self) -> [u8; 32] {
        env::sha256_array(near_sdk::borsh::to_vec(self).expect("encodes"))
    }
}
impl DeliverySignerMessage {
    pub fn digest(&self) -> [u8; 32] {
        env::sha256_array(near_sdk::borsh::to_vec(self).expect("encodes"))
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, Copy)]
pub enum Verdict {
    Cleared,
    Held,
    Seized,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Receipt {
    pub id: u32,
    pub verdict: Verdict,
    /// Machine-readable reason codes; empty when cleared.
    pub reasons: Vec<String>,
    pub supplier_id: String,
    pub invoice_number: String,
    pub order_id: String,
    pub amount: U128,
    pub token: String,
    pub payee: PayoutRoute,
    /// Fingerprints: the original document, the signed invoice, the signed delivery note.
    pub document_hash: String,
    pub invoice_digest: String,
    pub delivery_digest: String,
    pub decided_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Limits {
    /// Largest single invoice that can clear. Zero means nothing clears yet.
    pub per_invoice: U128,
    /// Most that can clear for one supplier within one period. Periods are
    /// fixed windows counted from 1 Jan 1970 UTC (not a rolling window), so a
    /// supplier can reach the cap at the end of one window and again at the start
    /// of the next.
    pub per_supplier_per_period: U128,
    pub period_hours: U64,
    /// Most invoices the agent may submit per UTC day (any verdict). Bounds the
    /// storage a compromised agent can make the contract pay for.
    pub max_submissions_per_day: u32,
}

/// Used when no limits are set yet.
pub const DEFAULT_SUBMISSIONS_PER_DAY: u32 = 100;
/// NEAR the contract keeps free for writes that must always succeed (0.05 NEAR).
pub const MIN_FREE_BALANCE_YOCTO: u128 = 50_000_000_000_000_000_000_000;
const DAY_NS: u64 = 24 * 3_600_000_000_000;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct DailyCount {
    pub day: u64,
    pub count: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct PeriodSpend {
    pub period: u64,
    pub amount: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct InspectionResult {
    pub receipt_id: u32,
    pub verdict: Verdict,
    pub reasons: Vec<String>,
    /// Set only for CLEARED invoices: where the payment stands after this call.
    pub payment: Option<crate::payments::PaymentStatus>,
}

// ---------------------------------------------------------------------- contract methods

#[near]
impl Contract {
    /// Register a storekeeper: a delivery signer with the role "storekeeper".
    #[payable]
    pub fn add_storekeeper(&mut self, key: PublicKey) {
        self.add_delivery_signer(key, DEFAULT_ROLE.to_string());
    }

    /// Register a key that may sign delivery notes, with exactly one role
    /// (e.g. "storekeeper", "weighbridge", "inspector"). A key can hold one role only.
    #[payable]
    pub fn add_delivery_signer(&mut self, key: PublicKey, role: String) {
        self.assert_owner_with_yocto();
        validate_role(&role);
        require!(
            key.curve_type() == CurveType::ED25519,
            "storekeeper key must be ed25519"
        );
        require!(
            !self.storekeepers.contains(&key),
            "storekeeper already registered"
        );
        require!(
            !self.supplier_keys.contains_key(key.as_bytes()),
            "this key is a supplier key; supplier and storekeeper keys must differ"
        );
        require!(self.storekeepers.len() < 20, "too many storekeepers");
        self.storekeepers.push(key.clone());
        env::storage_write(&role_key(&key), role.as_bytes());
        emit("storekeeper_added", json!({ "key": key, "role": role }));
    }

    /// Remove a delivery signer. Its signatures stop counting at once, including ones
    /// already made for deliveries that have not been submitted yet.
    #[payable]
    pub fn remove_storekeeper(&mut self, key: PublicKey) {
        self.assert_owner_with_yocto();
        let before = self.storekeepers.len();
        self.storekeepers.retain(|k| k != &key);
        require!(self.storekeepers.len() < before, "unknown storekeeper");
        env::storage_remove(&role_key(&key));
        emit("storekeeper_removed", json!({ "key": key }));
    }

    /// Set how many distinct roles must sign deliveries for an order, and which roles
    /// count (empty = any). Every change raises the policy version, and signatures made
    /// under an earlier version no longer count.
    #[payable]
    pub fn set_delivery_policy(&mut self, order_id: String, required: u8, roles: Vec<String>) {
        self.assert_owner_with_yocto();
        require!(self.orders.contains_key(&order_id), "unknown order");
        require!(
            required >= 1 && (required as usize) <= MAX_DELIVERY_SIGNATURES,
            "required signatures must be 1 to 5"
        );
        require!(roles.len() <= MAX_DELIVERY_SIGNATURES, "at most 5 roles");
        for (i, r) in roles.iter().enumerate() {
            validate_role(r);
            require!(!roles[..i].contains(r), "a role is listed twice");
        }
        require!(
            roles.is_empty() || required as usize <= roles.len(),
            "more signatures required than roles allowed"
        );
        let version = delivery_policy(&order_id)
            .version
            .checked_add(1)
            .expect("overflow");
        let policy = DeliveryPolicy {
            required,
            roles,
            version,
        };
        env::storage_write(
            &policy_key(&order_id),
            &near_sdk::borsh::to_vec(&policy).expect("encodes"),
        );
        emit(
            "delivery_policy_set",
            json!({ "order_id": order_id, "policy": policy }),
        );
    }

    /// Record a purchase order. Invoices are checked against it line by line.
    #[payable]
    pub fn create_order(
        &mut self,
        order_id: String,
        supplier_id: String,
        token: String,
        lines: Vec<OrderLine>,
    ) {
        self.assert_owner_with_yocto();
        self.assert_not_paused();
        validate_ref(&order_id, "order id");
        require!(
            self.suppliers.contains_key(&supplier_id),
            "unknown supplier"
        );
        require!(!self.orders.contains_key(&order_id), "order already exists");
        validate_token(&token);
        require!(
            !lines.is_empty() && lines.len() <= MAX_LINES,
            "order needs 1 to 50 lines"
        );
        for (i, l) in lines.iter().enumerate() {
            validate_ref(&l.sku, "sku");
            require!(
                l.qty.0 > 0 && l.unit_price.0 > 0,
                "order lines need a quantity and a price"
            );
            require!(
                !lines[..i].iter().any(|o| o.sku == l.sku),
                "duplicate sku in order"
            );
        }
        let invoiced = vec![U64(0); lines.len()];
        self.orders.insert(
            order_id.clone(),
            Order {
                supplier_id: supplier_id.clone(),
                token,
                lines,
                invoiced,
            },
        );
        emit(
            "order_created",
            json!({ "order_id": order_id, "supplier_id": supplier_id }),
        );
    }

    #[payable]
    pub fn set_limits(
        &mut self,
        per_invoice: U128,
        per_supplier_per_period: U128,
        period_hours: U64,
        max_submissions_per_day: u32,
    ) {
        self.assert_owner_with_yocto();
        require!(
            (1..=1000).contains(&max_submissions_per_day),
            "daily submission limit must be 1 to 1000"
        );
        require!(
            period_hours.0 >= 1 && period_hours.0 <= 24 * 366,
            "period must be 1 hour to 1 year"
        );
        require!(
            per_invoice.0 <= per_supplier_per_period.0,
            "per-invoice limit cannot exceed the period limit"
        );
        self.limits = Limits {
            per_invoice,
            per_supplier_per_period,
            period_hours,
            max_submissions_per_day,
        };
        emit("limits_set", json!({ "limits": self.limits }));
    }

    /// The one method the agent's function-call key is allowed to call.
    /// It takes no deposit, so a key limited to it can never attach funds.
    pub fn submit_invoice(
        &mut self,
        invoice: Invoice,
        supplier_signature: Base64VecU8,
        delivery: DeliveryNote,
        delivery_signatures: Vec<DeliverySignature>,
        document_hash: Base64VecU8,
    ) -> InspectionResult {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the buyer's agent can submit invoices"
        );
        self.assert_not_paused();
        // Storage protection: keep a reserve of NEAR so the contract can always
        // record cancellations, withdrawals and payout results.
        let storage_cost = env::storage_byte_cost()
            .as_yoctonear()
            .saturating_mul(env::storage_usage() as u128);
        require!(
            env::account_balance()
                .as_yoctonear()
                .saturating_sub(storage_cost)
                >= MIN_FREE_BALANCE_YOCTO,
            "contract storage budget is low; the buyer must top up NEAR before more submissions"
        );
        let doc: [u8; 32] = document_hash
            .0
            .clone()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("document hash must be 32 bytes (sha-256)"));
        // Storage protection: a hard cap on submissions per UTC day, whatever the verdict.
        let today = now() / DAY_NS;
        let cap = match self.limits.max_submissions_per_day {
            0 => DEFAULT_SUBMISSIONS_PER_DAY,
            n => n,
        };
        if self.submissions.day != today {
            self.submissions = DailyCount {
                day: today,
                count: 0,
            };
        }
        require!(
            self.submissions.count < cap,
            "daily submission limit reached"
        );
        self.submissions.count += 1;
        validate_ref(&invoice.supplier_id, "supplier id");
        validate_ref(&invoice.invoice_number, "invoice number");
        validate_ref(&invoice.order_id, "order id");
        validate_ref(&delivery.note_id, "delivery note id");
        validate_route(&invoice.payee);
        require!(
            !invoice.lines.is_empty() && invoice.lines.len() <= MAX_LINES,
            "invoice needs 1 to 50 lines"
        );
        require!(
            delivery.lines.len() <= MAX_LINES,
            "delivery note has too many lines"
        );
        require!(
            delivery_signatures.len() <= MAX_DELIVERY_SIGNATURES,
            "at most 5 delivery signatures"
        );

        let t = now();
        let contract = env::current_account_id();
        let invoice_digest = InvoiceMessage {
            domain: INVOICE_DOMAIN.into(),
            contract: contract.clone(),
            invoice: invoice.clone(),
            document_hash: doc,
        }
        .digest();
        let delivery_digest = DeliveryMessage {
            domain: DELIVERY_DOMAIN.into(),
            contract: contract.clone(),
            note: delivery.clone(),
        }
        .digest();

        let mut seize: Vec<&str> = Vec::new();
        let mut hold: Vec<&str> = Vec::new();

        // 1. Who is asking to be paid, and are they who they say they are?
        let mut supplier_signature_ok = false;
        let supplier = self.suppliers.get(&invoice.supplier_id).cloned();
        match &supplier {
            None => hold.push("unknown_supplier"),
            Some(rec) => {
                supplier_signature_ok =
                    verify_ed25519(&rec.signing_key, &invoice_digest, &supplier_signature.0);
                if !supplier_signature_ok {
                    seize.push("invalid_supplier_signature");
                }
                if delivery_signatures.iter().any(|s| s.key == rec.signing_key) {
                    hold.push("storekeeper_is_supplier");
                }
                let mut rec = rec.clone();
                settle(&mut rec, t);
                let payable = route_payable_at(&rec, t);
                if payable.as_ref() != Some(&invoice.payee) {
                    let on_file = rec.route == invoice.payee;
                    let pending = rec
                        .pending
                        .as_ref()
                        .is_some_and(|p| p.route == invoice.payee);
                    if on_file || pending {
                        hold.push("payee_not_yet_payable");
                    } else {
                        seize.push("payee_mismatch");
                    }
                }
            }
        }

        // 2. Has this been seen before?
        // "|" can never appear in an id, so two different pairs can never produce the same key.
        let invoice_key = format!("{}|{}", invoice.supplier_id, invoice.invoice_number);
        if self.cleared_invoices.contains_key(&invoice_key) {
            seize.push("duplicate_invoice");
        }
        if self.seen_documents.contains_key(&document_hash.0) {
            seize.push("duplicate_document");
        }

        // 3. Does it match the order and what was delivered?
        let note_key = format!("{}|{}", delivery.order_id, delivery.note_id);
        let order = self.orders.get(&invoice.order_id).cloned();
        let mut total: Option<u128> = Some(0);
        match &order {
            None => hold.push("unknown_order"),
            Some(o) => {
                if o.supplier_id != invoice.supplier_id {
                    hold.push("order_supplier_mismatch");
                }
                if o.token != invoice.token {
                    hold.push("token_mismatch");
                }
                // Two-person rule: enough distinct roles must sign this exact note.
                let policy = delivery_policy(&invoice.order_id);
                let mut keys_seen: Vec<&PublicKey> = Vec::new();
                let mut roles_signed: Vec<String> = Vec::new();
                for s in &delivery_signatures {
                    if keys_seen.contains(&&s.key) {
                        hold.push("duplicate_delivery_signer");
                        continue;
                    }
                    keys_seen.push(&s.key);
                    if self.supplier_keys.contains_key(s.key.as_bytes()) {
                        hold.push("storekeeper_is_supplier");
                        continue;
                    }
                    if !self.storekeepers.contains(&s.key) {
                        hold.push("unknown_storekeeper");
                        continue;
                    }
                    let role = signer_role(&s.key);
                    let digest = DeliverySignerMessage {
                        domain: DELIVERY_SIGNER_DOMAIN.into(),
                        contract: contract.clone(),
                        note: delivery.clone(),
                        role: role.clone(),
                        policy_version: policy.version,
                    }
                    .digest();
                    if !verify_ed25519(&s.key, &digest, &s.signature.0) {
                        hold.push("invalid_delivery_signature");
                    } else if !policy.roles.is_empty() && !policy.roles.contains(&role) {
                        hold.push("delivery_signer_role_not_allowed");
                    } else if roles_signed.contains(&role) {
                        hold.push("duplicate_delivery_role");
                    } else {
                        roles_signed.push(role);
                    }
                }
                if roles_signed.len() < policy.required as usize {
                    hold.push("delivery_signatures_missing");
                }
                if delivery.order_id != invoice.order_id {
                    hold.push("delivery_order_mismatch");
                }
                if self.used_delivery_notes.contains_key(&note_key) {
                    seize.push("delivery_note_reused");
                }
                for (i, line) in invoice.lines.iter().enumerate() {
                    if invoice.lines[..i].iter().any(|l| l.sku == line.sku) {
                        hold.push("duplicate_line");
                        continue;
                    }
                    let Some(idx) = o.lines.iter().position(|l| l.sku == line.sku) else {
                        hold.push("line_not_on_order");
                        continue;
                    };
                    if line.unit_price != o.lines[idx].unit_price {
                        hold.push("price_mismatch");
                    }
                    let delivered: u64 = delivery
                        .lines
                        .iter()
                        .filter(|d| d.sku == line.sku)
                        .map(|d| d.qty.0)
                        .fold(0, u64::saturating_add);
                    if line.qty.0 > delivered {
                        hold.push("quantity_exceeds_delivery");
                    }
                    if o.invoiced[idx].0.saturating_add(line.qty.0) > o.lines[idx].qty.0 {
                        hold.push("quantity_exceeds_order");
                    }
                    total = total.and_then(|acc| {
                        (line.qty.0 as u128)
                            .checked_mul(line.unit_price.0)
                            .and_then(|v| acc.checked_add(v))
                    });
                }
            }
        }

        // 4. Do the numbers add up, and is it within limits?
        let amount = invoice.total.0;
        match total {
            None => hold.push("arithmetic_overflow"),
            Some(sum) if order.is_some() && sum != amount => hold.push("total_mismatch"),
            _ => {}
        }
        if amount == 0 {
            hold.push("zero_amount");
        }
        let period_ns = self
            .limits
            .period_hours
            .0
            .saturating_mul(3_600_000_000_000)
            .max(1);
        let period = t / period_ns;
        let spent_now = self
            .spent
            .get(&invoice.supplier_id)
            .filter(|s| s.period == period)
            .map(|s| s.amount)
            .unwrap_or(0);
        if self.limits.per_invoice.0 == 0 {
            hold.push("limits_not_set");
        } else {
            if amount > self.limits.per_invoice.0 {
                hold.push("over_invoice_limit");
            }
            if spent_now.saturating_add(amount) > self.limits.per_supplier_per_period.0 {
                hold.push("over_period_limit");
            }
        }

        // 5. Stamp it.
        let verdict = if !seize.is_empty() {
            Verdict::Seized
        } else if !hold.is_empty() {
            Verdict::Held
        } else {
            Verdict::Cleared
        };
        let mut reasons: Vec<String> = seize
            .iter()
            .chain(hold.iter())
            .map(|s| s.to_string())
            .collect();
        let mut seen_reasons: Vec<String> = Vec::new();
        reasons.retain(|r| {
            let new = !seen_reasons.contains(r);
            if new {
                seen_reasons.push(r.clone());
            }
            new
        });

        let id = self.receipts.len();
        match verdict {
            Verdict::Cleared => {
                self.cleared_invoices.insert(invoice_key, id);
                self.seen_documents.insert(document_hash.0.clone(), id);
                self.used_delivery_notes.insert(note_key, id);
                let o = self
                    .orders
                    .get_mut(&invoice.order_id)
                    .expect("checked above");
                for line in &invoice.lines {
                    let idx = o
                        .lines
                        .iter()
                        .position(|l| l.sku == line.sku)
                        .expect("checked above");
                    o.invoiced[idx] = U64(o.invoiced[idx].0 + line.qty.0);
                }
                self.spent.insert(
                    invoice.supplier_id.clone(),
                    PeriodSpend {
                        period,
                        amount: spent_now + amount,
                    },
                );
            }
            // A seized document can never come back. Its invoice number is not
            // reserved, so a forged copy cannot block the real supplier's invoice.
            // Only an authenticated document is remembered as seized. A forged
            // invoice must not be able to "use up" the fingerprint of a real one.
            Verdict::Seized => {
                if supplier_signature_ok {
                    self.seen_documents.insert(document_hash.0.clone(), id);
                }
            }
            Verdict::Held => {}
        }

        let receipt = Receipt {
            id,
            verdict,
            reasons: reasons.clone(),
            supplier_id: invoice.supplier_id.clone(),
            invoice_number: invoice.invoice_number.clone(),
            order_id: invoice.order_id.clone(),
            amount: U128(amount),
            token: invoice.token.clone(),
            payee: invoice.payee.clone(),
            document_hash: hex(&document_hash.0),
            invoice_digest: hex(&invoice_digest),
            delivery_digest: hex(&delivery_digest),
            decided_at: U64(t),
        };
        self.receipts.push(receipt);
        emit(
            "invoice_inspected",
            json!({ "receipt_id": id, "verdict": verdict, "reasons": reasons, "supplier_id": invoice.supplier_id, "invoice_number": invoice.invoice_number, "amount": U128(amount) }),
        );
        let payment = (verdict == Verdict::Cleared).then(|| self.authorize_payment(id, &invoice));
        InspectionResult {
            receipt_id: id,
            verdict,
            reasons,
            payment,
        }
    }

    // ------------------------------------------------------------------ views

    pub fn get_receipt(&self, receipt_id: u32) -> Option<Receipt> {
        self.receipts.get(receipt_id).cloned()
    }

    pub fn receipt_count(&self) -> u32 {
        self.receipts.len()
    }

    pub fn get_order(&self, order_id: String) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }

    pub fn get_limits(&self) -> Limits {
        self.limits.clone()
    }

    pub fn get_delivery_signers(&self) -> Vec<DeliverySigner> {
        self.storekeepers
            .iter()
            .map(|k| DeliverySigner {
                key: k.clone(),
                role: signer_role(k),
            })
            .collect()
    }

    pub fn get_delivery_policy(&self, order_id: String) -> DeliveryPolicy {
        delivery_policy(&order_id)
    }

    pub fn get_storekeepers(&self) -> Vec<PublicKey> {
        self.storekeepers.clone()
    }
}

// ---------------------------------------------------------------------- helpers

fn validate_ref(s: &str, what: &str) {
    let ok = !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/'));
    if !ok {
        env::panic_str(&format!(
            "{what} must be 1 to 64 characters of A-Z, a-z, 0-9, '-', '_', '.', '/'"
        ));
    }
}

fn validate_token(s: &str) {
    require!(
        !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_graphic()),
        "invalid token id"
    );
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
