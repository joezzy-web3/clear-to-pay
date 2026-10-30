//! Clear to Pay: a payment guardrail for AI agents.
//!
//! The AI reads invoices; this contract decides. This first module is the
//! supplier registry: the one place a payout address can come from.
//!
//! Rules enforced here:
//! - Only the buyer (owner) can register a supplier, after confirming the
//!   supplier out of band. A newly registered route is not payable for 72 hours.
//! - A payout change must be signed by the supplier's own key, approved by the
//!   buyer, and then wait 72 hours from the proposal. An email, an invoice or an
//!   AI cannot change where money goes.
//! - While a change is pending, the old route stays payable and the new one does not.
//! - The pause switch only stops activity.
//! - Money can only ever go to a supplier's registered, payable route, or back to
//!   the owner (unreserved funds only, via `withdraw`). No function sends funds to
//!   any other address, and none can touch money reserved for a payment in flight.
//! - Supplier and storekeeper keys must be different keys, so the delivery check
//!   stays independent of the party being paid.

use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, CurveType, PanicOnDefault, PublicKey, env, near, require};

/// How long a new or changed payout route waits before it can receive funds.
pub const COOL_OFF_NS: u64 = 72 * 60 * 60 * 1_000_000_000;

/// Domain tag mixed into every signed payout change, so a signature made for
/// anything else (another contract, another message type) can never be reused here.
pub const PAYOUT_CHANGE_DOMAIN: &str = "clear-to-pay/payout-change/v1";

/// Where and how a supplier is paid.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayoutRoute {
    /// Destination chain, e.g. "near" or "base".
    pub chain: String,
    /// Token identifier on that chain, e.g. the USDC contract.
    pub token: String,
    /// Recipient address or account on that chain.
    pub address: String,
}

/// A supplier-signed change that has not taken effect yet.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingChange {
    pub route: PayoutRoute,
    /// When the supplier's signed proposal reached the contract (nanoseconds).
    pub proposed_at: U64,
    /// Whether the buyer has approved it.
    pub approved: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct SupplierRecord {
    /// The supplier's own ed25519 key. Only signatures from this key can propose changes.
    pub signing_key: PublicKey,
    /// The route currently on file.
    pub route: PayoutRoute,
    /// When `route` becomes payable (nanoseconds).
    pub route_payable_from: u64,
    /// Highest nonce the supplier has used; each signed change must use a larger one.
    pub last_nonce: u64,
    pub pending: Option<PendingChange>,
}

/// What a view call returns about a supplier.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SupplierView {
    pub supplier_id: String,
    pub signing_key: PublicKey,
    /// The route money may go to right now, if any.
    pub payable_route: Option<PayoutRoute>,
    /// The route on file and when it becomes (or became) payable.
    pub route_on_file: PayoutRoute,
    pub route_payable_from: U64,
    pub pending: Option<PendingChange>,
    pub last_nonce: U64,
}

/// The exact bytes a supplier signs to propose a payout change.
#[near(serializers = [borsh])]
pub struct PayoutChangeMessage {
    pub domain: String,
    pub contract: AccountId,
    pub supplier_id: String,
    pub nonce: u64,
    pub route: PayoutRoute,
}

impl PayoutChangeMessage {
    /// sha256 over the borsh encoding. Suppliers sign these 32 bytes.
    pub fn digest(&self) -> [u8; 32] {
        let bytes = near_sdk::borsh::to_vec(self).expect("message encodes");
        env::sha256_array(&bytes)
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    paused: bool,
    suppliers: LookupMap<String, SupplierRecord>,
    // inspection state (see inspection.rs)
    storekeepers: Vec<PublicKey>,
    orders: LookupMap<String, inspection::Order>,
    receipts: near_sdk::store::Vector<inspection::Receipt>,
    cleared_invoices: LookupMap<String, u32>,
    seen_documents: LookupMap<Vec<u8>, u32>,
    used_delivery_notes: LookupMap<String, u32>,
    limits: inspection::Limits,
    spent: LookupMap<String, inspection::PeriodSpend>,
    // payment state (see payments.rs)
    allowed_tokens: Vec<AccountId>,
    funds: LookupMap<AccountId, payments::Funds>,
    payments: LookupMap<u32, payments::Payment>,
    // role separation and storage protection (audit fixes, 30 Oct)
    supplier_keys: LookupMap<Vec<u8>, String>,
    submissions: inspection::DailyCount,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            paused: false,
            suppliers: LookupMap::new(b"s"),
            storekeepers: Vec::new(),
            orders: LookupMap::new(b"o"),
            receipts: near_sdk::store::Vector::new(b"r"),
            cleared_invoices: LookupMap::new(b"c"),
            seen_documents: LookupMap::new(b"d"),
            used_delivery_notes: LookupMap::new(b"n"),
            limits: inspection::Limits::default(),
            spent: LookupMap::new(b"p"),
            allowed_tokens: Vec::new(),
            funds: LookupMap::new(b"f"),
            payments: LookupMap::new(b"y"),
            supplier_keys: LookupMap::new(b"k"),
            submissions: inspection::DailyCount::default(),
        }
    }

    // ---------------------------------------------------------------- owner actions

    /// Register a supplier after confirming them out of band (for example a call
    /// to a number already on file). The route is not payable for 72 hours.
    #[payable]
    pub fn register_supplier(
        &mut self,
        supplier_id: String,
        signing_key: PublicKey,
        route: PayoutRoute,
    ) {
        self.assert_owner_with_yocto();
        self.assert_not_paused();
        validate_supplier_id(&supplier_id);
        validate_route(&route);
        require!(
            signing_key.curve_type() == CurveType::ED25519,
            "signing key must be ed25519"
        );
        require!(
            !self.suppliers.contains_key(&supplier_id),
            "supplier already registered"
        );
        require!(
            !self.storekeepers.contains(&signing_key),
            "this key is a storekeeper key; supplier and storekeeper keys must differ"
        );
        require!(
            !self.supplier_keys.contains_key(signing_key.as_bytes()),
            "this key already belongs to another supplier"
        );
        self.supplier_keys
            .insert(signing_key.as_bytes().to_vec(), supplier_id.clone());

        let payable_from = now() + COOL_OFF_NS;
        self.suppliers.insert(
            supplier_id.clone(),
            SupplierRecord {
                signing_key,
                route: route.clone(),
                route_payable_from: payable_from,
                last_nonce: 0,
                pending: None,
            },
        );
        emit(
            "supplier_registered",
            json!({ "supplier_id": supplier_id, "route": route, "payable_from": U64(payable_from) }),
        );
    }

    /// Approve the supplier's pending, signed change. It still only takes effect
    /// 72 hours after it was proposed.
    #[payable]
    pub fn approve_payout_change(&mut self, supplier_id: String) {
        self.assert_owner_with_yocto();
        self.assert_not_paused();
        let rec = self.record_mut(&supplier_id);
        settle(rec, now());
        let pending = rec
            .pending
            .as_mut()
            .unwrap_or_else(|| env::panic_str("no pending change"));
        require!(!pending.approved, "change already approved");
        pending.approved = true;
        let effective_at = pending.proposed_at.0 + COOL_OFF_NS;
        let route = pending.route.clone();
        emit(
            "payout_change_approved",
            json!({ "supplier_id": supplier_id, "route": route, "effective_at": U64(effective_at) }),
        );
    }

    /// Cancel a pending change. Allowed while paused, so a bad change can always be stopped.
    #[payable]
    pub fn cancel_payout_change(&mut self, supplier_id: String) {
        self.assert_owner_with_yocto();
        let rec = self.record_mut(&supplier_id);
        settle(rec, now());
        require!(rec.pending.is_some(), "no pending change");
        let cancelled = rec.pending.take().map(|p| p.route);
        emit(
            "payout_change_cancelled",
            json!({ "supplier_id": supplier_id, "route": cancelled }),
        );
    }

    /// Stop all new activity. Moves no funds.
    #[payable]
    pub fn pause(&mut self) {
        self.assert_owner_with_yocto();
        require!(!self.paused, "already paused");
        self.paused = true;
        emit("paused", json!({}));
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner_with_yocto();
        require!(self.paused, "not paused");
        self.paused = false;
        emit("unpaused", json!({}));
    }

    // ---------------------------------------------------------------- supplier actions

    /// Propose a new payout route, signed by the supplier's key. Anyone may relay
    /// the signed proposal; only the signature matters. It needs the buyer's
    /// approval and a 72-hour wait before money can go to the new route.
    pub fn propose_payout_change(
        &mut self,
        supplier_id: String,
        route: PayoutRoute,
        nonce: U64,
        signature: Base64VecU8,
    ) {
        self.assert_not_paused();
        validate_route(&route);
        let contract = env::current_account_id();
        let t = now();
        let rec = self.record_mut(&supplier_id);
        settle(rec, t);
        require!(nonce.0 > rec.last_nonce, "nonce already used");

        let digest = PayoutChangeMessage {
            domain: PAYOUT_CHANGE_DOMAIN.to_string(),
            contract,
            supplier_id: supplier_id.clone(),
            nonce: nonce.0,
            route: route.clone(),
        }
        .digest();
        require!(
            verify_ed25519(&rec.signing_key, &digest, &signature.0),
            "invalid supplier signature"
        );

        rec.last_nonce = nonce.0;
        rec.pending = Some(PendingChange {
            route: route.clone(),
            proposed_at: U64(t),
            approved: false,
        });
        emit(
            "payout_change_proposed",
            json!({ "supplier_id": supplier_id, "route": route, "nonce": nonce, "earliest_effective_at": U64(t + COOL_OFF_NS) }),
        );
    }

    // ---------------------------------------------------------------- views

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn get_supplier(&self, supplier_id: String) -> Option<SupplierView> {
        let mut rec = self.suppliers.get(&supplier_id)?.clone();
        let t = now();
        settle(&mut rec, t);
        Some(SupplierView {
            payable_route: route_payable_at(&rec, t),
            supplier_id,
            signing_key: rec.signing_key,
            route_on_file: rec.route,
            route_payable_from: U64(rec.route_payable_from),
            pending: rec.pending,
            last_nonce: U64(rec.last_nonce),
        })
    }

    /// The only route money may be sent to right now, or none.
    pub fn payable_route(&self, supplier_id: String) -> Option<PayoutRoute> {
        let mut rec = self.suppliers.get(&supplier_id)?.clone();
        let t = now();
        settle(&mut rec, t);
        route_payable_at(&rec, t)
    }

    /// True only if `route` is exactly the supplier's payable route right now.
    pub fn is_payable(&self, supplier_id: String, route: PayoutRoute) -> bool {
        self.payable_route(supplier_id).is_some_and(|r| r == route)
    }

    // ---------------------------------------------------------------- internals

    fn assert_owner_with_yocto(&self) {
        near_sdk::assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner can do this"
        );
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "contract is paused");
    }

    fn record_mut(&mut self, supplier_id: &str) -> &mut SupplierRecord {
        self.suppliers
            .get_mut(supplier_id)
            .unwrap_or_else(|| env::panic_str("unknown supplier"))
    }
}

pub(crate) fn now() -> u64 {
    env::block_timestamp()
}

/// Promote an approved change once its 72 hours have passed. The new route is
/// payable from that moment; the old one stops being payable at the same moment.
pub(crate) fn settle(rec: &mut SupplierRecord, t: u64) {
    if let Some(p) = &rec.pending {
        let effective_at = p.proposed_at.0 + COOL_OFF_NS;
        if p.approved && t >= effective_at {
            rec.route = p.route.clone();
            rec.route_payable_from = effective_at;
            rec.pending = None;
        }
    }
}

pub(crate) fn route_payable_at(rec: &SupplierRecord, t: u64) -> Option<PayoutRoute> {
    (t >= rec.route_payable_from).then(|| rec.route.clone())
}

pub(crate) fn verify_ed25519(key: &PublicKey, message: &[u8; 32], signature: &[u8]) -> bool {
    if key.curve_type() != CurveType::ED25519 || signature.len() != 64 {
        return false;
    }
    let key_bytes: [u8; 32] = match key.as_bytes()[1..].try_into() {
        Ok(b) => b,
        Err(_) => return false,
    };
    let sig: [u8; 64] = signature.try_into().expect("length checked");
    env::ed25519_verify(&sig, message, &key_bytes)
}

pub(crate) fn validate_supplier_id(id: &str) {
    require!(
        !id.is_empty() && id.len() <= 64,
        "supplier id must be 1 to 64 characters"
    );
    require!(
        id.bytes().all(|b| b.is_ascii_lowercase()
            || b.is_ascii_digit()
            || matches!(b, b'-' | b'_' | b'.')),
        "supplier id may only use a-z, 0-9, '-', '_' and '.'"
    );
}

/// Routes are compared byte for byte, so only plain printable ASCII is accepted:
/// no spaces, no invisible characters, no lookalike letters from other alphabets.
pub(crate) fn validate_route(r: &PayoutRoute) {
    let clean = |s: &str, max: usize| {
        !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_graphic())
    };
    require!(
        clean(&r.chain, 32),
        "route chain must be 1 to 32 printable ASCII characters"
    );
    require!(
        clean(&r.token, 128),
        "route token must be 1 to 128 printable ASCII characters"
    );
    require!(
        clean(&r.address, 128),
        "route address must be 1 to 128 printable ASCII characters"
    );
    if r.chain == "near" {
        require!(
            r.address.parse::<AccountId>().is_ok() && r.token.parse::<AccountId>().is_ok(),
            "NEAR routes need a valid account and token contract"
        );
    }
}

pub(crate) fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let log =
        json!({ "standard": "cleartopay", "version": "0.1.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

pub mod inspection;
pub mod payments;

#[cfg(test)]
mod audit_tests;
#[cfg(test)]
mod inspection_tests;
#[cfg(test)]
mod payment_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod vector_tests;
