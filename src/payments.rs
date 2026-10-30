//! Payments: only a CLEARED receipt can move money, and only to the supplier's
//! registered route.
//!
//! Funds: the buyer deposits a token it has allowed (e.g. USDC) with
//! `ft_transfer_call`. Deposits from anyone else, or of any other token, are refused.
//!
//! Every payment moves through fixed states:
//!
//!   AUTHORIZED -> RESERVED -> SUBMITTED -> SETTLED
//!                                       -> FAILED   (funds return to the pool)
//!   AUTHORIZED -> EXPIRED   (not paid within 7 days of clearing)
//!   AUTHORIZED -> CANCELLED (by the buyer)
//!   FAILED | EXPIRED | CANCELLED -> AUTHORIZED (buyer reauthorises; new attempt,
//!                                               paid to the supplier's CURRENT route)
//!
//! Any other transition is refused. A payment that is not SUBMITTED can never be
//! settled, and a settled payment can never be paid again.
//!
//! If a transfer's callback never runs (for example it ran out of gas), the
//! payment stays SUBMITTED with its funds reserved: never retried blindly. After
//! 24 hours the buyer can resolve it, stating whether the supplier was paid; the
//! decision is logged publicly.

use crate::*;
use near_sdk::json_types::U128;
use near_sdk::{Gas, NearToken, Promise, PromiseOrValue, ext_contract};

/// How long a cleared payment may wait for funds before it expires.
pub const PAYMENT_TTL_NS: u64 = 7 * 24 * 3_600_000_000_000;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(20);
/// How long a SUBMITTED payment must wait before the buyer may resolve it by hand.
pub const STUCK_AFTER_NS: u64 = 24 * 3_600_000_000_000;
/// Gas that must remain for a payout to be sent in the same call.
const GAS_NEEDED_TO_PAY: Gas = Gas::from_tgas(45);

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaymentStatus {
    Authorized,
    Reserved,
    Submitted,
    Settled,
    Failed,
    Expired,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Payment {
    pub receipt_id: u32,
    pub status: PaymentStatus,
    pub supplier_id: String,
    pub token: String,
    pub amount: U128,
    /// The route that was payable when the invoice cleared.
    pub recipient: PayoutRoute,
    pub authorized_at: U64,
    pub updated_at: U64,
    /// 1 for the first authorisation; +1 for every buyer reauthorisation.
    pub attempt: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Funds {
    /// Deposited and free to pay new invoices.
    pub available: U128,
    /// Committed to payments that are on their way.
    pub reserved: U128,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near]
impl Contract {
    /// Allow a token contract (e.g. testnet USDC) to be deposited and paid out.
    #[payable]
    pub fn allow_token(&mut self, token: AccountId) {
        self.assert_owner_with_yocto();
        require!(
            !self.allowed_tokens.contains(&token),
            "token already allowed"
        );
        require!(self.allowed_tokens.len() < 10, "too many tokens");
        self.allowed_tokens.push(token.clone());
        emit("token_allowed", json!({ "token": token }));
    }

    /// NEP-141 deposit hook. Keeps the tokens only if they come from the buyer
    /// and from an allowed token contract; otherwise returns them in full.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = msg;
        let token = env::predecessor_account_id();
        if !self.allowed_tokens.contains(&token) || sender_id != self.owner || amount.0 == 0 {
            emit(
                "deposit_refused",
                json!({ "token": token, "sender": sender_id, "amount": amount }),
            );
            return PromiseOrValue::Value(amount);
        }
        let mut f = self.funds.get(&token).cloned().unwrap_or_default();
        f.available = U128(
            f.available
                .0
                .checked_add(amount.0)
                .expect("balance overflow"),
        );
        self.funds.insert(token.clone(), f);
        emit("deposit", json!({ "token": token, "amount": amount }));
        PromiseOrValue::Value(U128(0))
    }

    /// Try again to pay a CLEARED invoice that was waiting (for funds, gas or an
    /// allowed token). Moves no money unless every payment rule still holds.
    pub fn execute_payment(&mut self, receipt_id: u32) -> PaymentStatus {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the buyer can execute payments"
        );
        self.assert_not_paused();
        let p = self
            .payments
            .get(&receipt_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no payment for this receipt"));
        require!(
            p.status == PaymentStatus::Authorized,
            "payment is not waiting to be paid"
        );
        if now() > p.authorized_at.0 + PAYMENT_TTL_NS {
            self.set_status(receipt_id, PaymentStatus::Expired);
            return PaymentStatus::Expired;
        }
        self.try_pay(receipt_id)
    }

    /// The buyer can cancel a payment that has not started moving.
    #[payable]
    pub fn cancel_payment(&mut self, receipt_id: u32) {
        self.assert_owner_with_yocto();
        self.set_status(receipt_id, PaymentStatus::Cancelled);
    }

    /// Give a FAILED, EXPIRED or CANCELLED payment a new attempt. Only the buyer can
    /// do this. The payment is bound to the supplier's route that is payable NOW,
    /// so an approved route change is respected and an old address is never reused.
    #[payable]
    pub fn reauthorize_payment(&mut self, receipt_id: u32) -> PaymentStatus {
        self.assert_owner_with_yocto();
        self.assert_not_paused();
        let p = self
            .payments
            .get(&receipt_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no payment for this receipt"));
        require!(
            matches!(
                p.status,
                PaymentStatus::Failed | PaymentStatus::Expired | PaymentStatus::Cancelled
            ),
            "only failed, expired or cancelled payments can be reauthorised"
        );
        let route = self
            .suppliers
            .get(&p.supplier_id)
            .cloned()
            .and_then(|mut rec| {
                settle(&mut rec, now());
                route_payable_at(&rec, now())
            })
            .unwrap_or_else(|| env::panic_str("supplier has no payable route"));
        self.set_status(receipt_id, PaymentStatus::Authorized);
        let q = self.payments.get_mut(&receipt_id).expect("payment exists");
        q.recipient = route.clone();
        q.authorized_at = U64(now());
        q.attempt += 1;
        let attempt = q.attempt;
        emit(
            "payment_reauthorized",
            json!({ "receipt_id": receipt_id, "attempt": attempt, "recipient": route }),
        );
        self.try_pay(receipt_id)
    }

    /// Resolve a payment whose transfer result was never recorded (its callback
    /// failed). Only the buyer, only for SUBMITTED payments, only after 24 hours.
    /// `supplier_was_paid` must reflect the token contract's own records (e.g. the
    /// transfer on NearBlocks). The decision is logged publicly with the receipt.
    #[payable]
    pub fn resolve_stuck_payment(
        &mut self,
        receipt_id: u32,
        supplier_was_paid: bool,
    ) -> PaymentStatus {
        self.assert_owner_with_yocto();
        let p = self
            .payments
            .get(&receipt_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no payment for this receipt"));
        require!(
            p.status == PaymentStatus::Submitted,
            "only a submitted payment can be resolved"
        );
        require!(
            now() >= p.updated_at.0 + STUCK_AFTER_NS,
            "a submitted payment can only be resolved 24 hours after it was sent"
        );
        let to = if supplier_was_paid {
            PaymentStatus::Settled
        } else {
            PaymentStatus::Failed
        };
        self.set_status(receipt_id, to);
        self.release_reserved(&p, supplier_was_paid);
        emit(
            "payment_resolved_by_buyer",
            json!({ "receipt_id": receipt_id, "supplier_was_paid": supplier_was_paid }),
        );
        to
    }

    /// Return unreserved funds to the buyer. Only ever pays the owner, and never
    /// touches money reserved for payments in flight.
    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        self.assert_owner_with_yocto();
        let mut f = self.funds.get(&token).cloned().unwrap_or_default();
        require!(
            amount.0 > 0 && amount.0 <= f.available.0,
            "not enough unreserved funds"
        );
        f.available = U128(f.available.0 - amount.0);
        self.funds.insert(token.clone(), f);
        emit(
            "withdraw_started",
            json!({ "token": token, "amount": amount }),
        );
        ext_ft::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(
                self.owner.clone(),
                amount,
                Some("clear-to-pay withdraw".into()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_withdraw(token, amount),
            )
    }

    // ------------------------------------------------------------------ callbacks

    #[private]
    pub fn on_payout(&mut self, receipt_id: u32) -> PaymentStatus {
        assert_self_callback();
        let ok = promise_succeeded();
        // State first: a payment that is not SUBMITTED aborts here, before any balance moves.
        let to = if ok {
            PaymentStatus::Settled
        } else {
            PaymentStatus::Failed
        };
        self.set_status(receipt_id, to);
        let p = self
            .payments
            .get(&receipt_id)
            .cloned()
            .expect("payment exists");
        self.release_reserved(&p, ok);
        to
    }

    #[private]
    pub fn on_withdraw(&mut self, token: AccountId, amount: U128) -> bool {
        assert_self_callback();
        let ok = promise_succeeded();
        if !ok {
            let mut f = self.funds.get(&token).cloned().unwrap_or_default();
            f.available = U128(
                f.available
                    .0
                    .checked_add(amount.0)
                    .expect("balance overflow"),
            );
            self.funds.insert(token.clone(), f);
        }
        emit(
            "withdraw_finished",
            json!({ "token": token, "amount": amount, "ok": ok }),
        );
        ok
    }

    // ------------------------------------------------------------------ views

    pub fn get_payment(&self, receipt_id: u32) -> Option<Payment> {
        self.payments.get(&receipt_id).cloned()
    }

    pub fn get_funds(&self, token: AccountId) -> Funds {
        self.funds.get(&token).cloned().unwrap_or_default()
    }

    pub fn get_allowed_tokens(&self) -> Vec<AccountId> {
        self.allowed_tokens.clone()
    }
}

impl Contract {
    /// Release a payment's reservation: gone for good if the supplier was paid,
    /// back to the available pool if not.
    fn release_reserved(&mut self, p: &Payment, supplier_was_paid: bool) {
        let token: AccountId = p.token.parse().expect("token was valid when paid");
        let mut f = self.funds.get(&token).cloned().unwrap_or_default();
        f.reserved = U128(
            f.reserved
                .0
                .checked_sub(p.amount.0)
                .expect("reserved covers payment"),
        );
        if !supplier_was_paid {
            f.available = U128(
                f.available
                    .0
                    .checked_add(p.amount.0)
                    .expect("balance overflow"),
            );
        }
        self.funds.insert(token, f);
    }

    /// Called by `submit_invoice` for a CLEARED invoice.
    pub(crate) fn authorize_payment(
        &mut self,
        receipt_id: u32,
        invoice: &inspection::Invoice,
    ) -> PaymentStatus {
        let t = now();
        let p = Payment {
            receipt_id,
            status: PaymentStatus::Authorized,
            supplier_id: invoice.supplier_id.clone(),
            token: invoice.token.clone(),
            amount: invoice.total,
            recipient: invoice.payee.clone(),
            authorized_at: U64(t),
            updated_at: U64(t),
            attempt: 1,
        };
        self.payments.insert(receipt_id, p);
        emit(
            "payment_authorized",
            json!({ "receipt_id": receipt_id, "amount": invoice.total }),
        );
        self.try_pay(receipt_id)
    }

    /// Reserve and send, if every condition holds. Otherwise leave it AUTHORIZED.
    fn try_pay(&mut self, receipt_id: u32) -> PaymentStatus {
        let p = self
            .payments
            .get(&receipt_id)
            .cloned()
            .expect("payment exists");

        // Cross-chain routes are paid through NEAR Intents (next build step).
        if p.recipient.chain != "near" {
            return self.waiting(receipt_id, "route_needs_intents");
        }
        // The route must still be the supplier's payable route right now.
        let still_payable = self
            .suppliers
            .get(&p.supplier_id)
            .cloned()
            .is_some_and(|mut rec| {
                settle(&mut rec, now());
                route_payable_at(&rec, now()).as_ref() == Some(&p.recipient)
            });
        if !still_payable {
            return self.waiting(receipt_id, "route_no_longer_payable");
        }
        let (Ok(token), Ok(receiver)) = (
            p.token.parse::<AccountId>(),
            p.recipient.address.parse::<AccountId>(),
        ) else {
            return self.waiting(receipt_id, "invalid_token_or_receiver");
        };
        if !self.allowed_tokens.contains(&token) || p.recipient.token != p.token {
            return self.waiting(receipt_id, "token_not_allowed");
        }
        let mut f = self.funds.get(&token).cloned().unwrap_or_default();
        if f.available.0 < p.amount.0 {
            return self.waiting(receipt_id, "insufficient_funds");
        }
        if env::prepaid_gas().saturating_sub(env::used_gas()) < GAS_NEEDED_TO_PAY {
            return self.waiting(receipt_id, "not_enough_gas");
        }

        f.available = U128(f.available.0 - p.amount.0);
        f.reserved = U128(f.reserved.0 + p.amount.0);
        self.funds.insert(token.clone(), f);
        self.set_status(receipt_id, PaymentStatus::Reserved);

        let _ = ext_ft::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(
                receiver,
                p.amount,
                Some(format!("clear-to-pay receipt {receipt_id}")),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_payout(receipt_id),
            );
        self.set_status(receipt_id, PaymentStatus::Submitted);
        PaymentStatus::Submitted
    }

    fn waiting(&self, receipt_id: u32, reason: &str) -> PaymentStatus {
        emit(
            "payment_waiting",
            json!({ "receipt_id": receipt_id, "reason": reason }),
        );
        PaymentStatus::Authorized
    }

    /// The only place a payment's status changes. Illegal moves abort the call.
    fn set_status(&mut self, receipt_id: u32, to: PaymentStatus) {
        use PaymentStatus::*;
        let p = self
            .payments
            .get_mut(&receipt_id)
            .unwrap_or_else(|| env::panic_str("no payment for this receipt"));
        let legal = matches!(
            (p.status, to),
            (Authorized, Reserved | Expired | Cancelled)
                | (Failed | Expired | Cancelled, Authorized)
                | (Reserved, Submitted)
                | (Submitted, Settled | Failed)
        );
        if !legal {
            env::panic_str(&format!(
                "illegal payment transition {:?} -> {:?}",
                p.status, to
            ));
        }
        let from = p.status;
        p.status = to;
        p.updated_at = U64(now());
        emit(
            "payment_status",
            json!({ "receipt_id": receipt_id, "from": from, "to": to }),
        );
    }
}

/// NEP-141 ft_transfer returns nothing, so success means "no error"; 64 bytes is plenty.
fn promise_succeeded() -> bool {
    env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok()
}

/// `#[private]` already enforces this on chain; checking again inside keeps the
/// rule visible and testable.
/// A direct call signed with the contract account's own key would also pass the
/// predecessor check, so we additionally require exactly one promise result,
/// which only exists when the call really follows a transfer.
fn assert_self_callback() {
    require!(
        env::predecessor_account_id() == env::current_account_id(),
        "only this contract can report payout results"
    );
    require!(
        env::promise_results_count() == 1,
        "callbacks must follow a transfer"
    );
}
