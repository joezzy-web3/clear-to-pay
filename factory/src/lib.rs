//! Clear to Pay factory: a buyer gets their own Clear to Pay contract with one ordinary
//! wallet call, no terminal.
//!
//! Wallets such as Meteor refuse to deploy code from a web page, so the page cannot do
//! the deploy itself. Instead the buyer calls `create` here with 3.6 NEAR attached. In one
//! batch on the new account `<label>.<this factory>` the factory:
//!
//!   1. creates the account,
//!   2. moves the buyer's deposit onto it (it pays for the code's storage),
//!   3. deploys exactly the embedded guard code (`res/clear_to_pay.wasm`),
//!   4. calls `new` with the buyer as owner.
//!
//! No access key is ever added, so nobody (not the buyer, not us) can sign for the new
//! account or change its code. A batch is all-or-nothing: if any step fails (name taken,
//! too little NEAR) nothing is created, and `on_created` sends the deposit back.
//!
//! Refunds: when a batch fails, NEAR returns the deposit to the factory in a separate
//! receipt that may land before or after `on_created`. So `on_created` pays the refund from
//! the factory's spare balance when it can, and otherwise records it as owed; the caller
//! takes it with `claim_refund` once the money is back. A refund is never lost.
//!
//! The only state is that list of owed refunds. `code_hash` lets anyone check which code
//! the factory deploys, and the console reads each new contract back from the chain (code
//! hash, owner, no keys) before it calls it ready.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, Gas, NearToken, Promise, PromiseOrValue, env, near, require};

/// The guard code every created contract runs. Byte for byte the wasm deployed at
/// guard.cleartopay.testnet; the tests check its sha256.
const GUARD_CODE: &[u8] = include_bytes!("../res/clear_to_pay.wasm");

/// sha256 of `GUARD_CODE`, hex. Also on the console page and in the README.
pub const GUARD_CODE_SHA256: &str =
    "9b998038ac549a37c871c431e28b125437f4c7f046799d8e4e5c139dbea0a2d1";

/// Storage for ~333 KB of code is ~3.33 NEAR at 1 NEAR per 100 KB; the rest covers the
/// contract's own records for a long while.
pub const MIN_DEPOSIT: NearToken = NearToken::from_millinear(3_600);
/// Anything above this is almost certainly a typo in a wallet; refuse rather than lock it
/// on an account nobody can withdraw NEAR from.
pub const MAX_DEPOSIT: NearToken = NearToken::from_near(5);

const GAS_INIT: Gas = Gas::from_tgas(30);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

const LABEL_MIN: usize = 2;
const LABEL_MAX: usize = 32;
/// Names that would look official. Refused so nobody can pass one off as ours.
const RESERVED: &[&str] = &[
    "admin",
    "cleartopay",
    "clear-to-pay",
    "clear_to_pay",
    "demo",
    "factory",
    "guard",
    "judge",
    "official",
    "support",
];
/// Kept back when deciding whether a refund can be paid now: room for one more owed record.
const STORAGE_MARGIN_BYTES: u64 = 500;

#[near(contract_state)]
pub struct Factory {
    /// Refunds that could not be paid at once (see the top of this file).
    owed: LookupMap<AccountId, NearToken>,
}

impl Default for Factory {
    fn default() -> Self {
        Self {
            owed: LookupMap::new(b"o"),
        }
    }
}

#[near]
impl Factory {
    /// Create `<label>.<this account>` running the guard code, owned by the caller.
    /// Attach between 3.6 and 5 NEAR; all of it goes to the new contract.
    #[payable]
    pub fn create(&mut self, label: String) -> Promise {
        require!(
            is_label(&label),
            "label: 2 to 32 characters, lowercase letters and digits, single - or _ between them"
        );
        require!(!RESERVED.contains(&label.as_str()), "that name is reserved");
        let deposit = env::attached_deposit();
        require!(
            deposit >= MIN_DEPOSIT,
            "attach at least 3.6 NEAR (it pays for the new contract's storage)"
        );
        require!(deposit <= MAX_DEPOSIT, "attach at most 5 NEAR");

        let name: AccountId = format!("{label}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("that name is not a valid NEAR account"));
        let owner = env::predecessor_account_id();

        emit(
            "create_started",
            json!({ "contract": name, "owner": owner, "deposit": U128(deposit.as_yoctonear()) }),
        );

        Promise::new(name.clone())
            .create_account()
            .transfer(deposit)
            .deploy_contract(GUARD_CODE.to_vec())
            .function_call(
                "new".to_string(),
                json!({ "owner": owner }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_INIT,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_created(name, owner, U128(deposit.as_yoctonear())),
            )
    }

    /// Runs after the batch. On success: done. On failure nothing was created, so the
    /// deposit goes back to the caller: now if the factory can pay it, otherwise recorded
    /// as owed for `claim_refund`. Never panics on a failed batch, so no refund is lost.
    #[private]
    pub fn on_created(
        &mut self,
        // Not called `contract`: near-sdk's generated wasm entry point already uses that name
        // for the factory's own state, and the two clash.
        new_account: AccountId,
        owner: AccountId,
        deposit: U128,
    ) -> PromiseOrValue<bool> {
        require!(
            env::promise_results_count() == 1,
            "only runs after a create batch"
        );
        // `new` returns nothing; the limit only bounds what we read.
        if env::promise_result_checked(0, 1024).is_ok() {
            emit(
                "contract_created",
                json!({ "contract": new_account, "owner": owner }),
            );
            PromiseOrValue::Value(true)
        } else if spare().as_yoctonear() >= deposit.0 {
            emit(
                "create_failed_refunded",
                json!({ "contract": new_account, "owner": owner, "refund": deposit }),
            );
            PromiseOrValue::Promise(
                Promise::new(owner).transfer(NearToken::from_yoctonear(deposit.0)),
            )
        } else {
            let before = self
                .owed
                .get(&owner)
                .copied()
                .unwrap_or(NearToken::from_yoctonear(0));
            let total = before.saturating_add(NearToken::from_yoctonear(deposit.0));
            self.owed.insert(owner.clone(), total);
            emit(
                "create_failed_refund_owed",
                json!({ "contract": new_account, "owner": owner, "owed": U128(total.as_yoctonear()) }),
            );
            PromiseOrValue::Value(false)
        }
    }

    /// Take a refund recorded as owed. Pays only the caller, only what it is owed, and only
    /// once the factory has the money back.
    pub fn claim_refund(&mut self) -> Promise {
        let me = env::predecessor_account_id();
        let amount = self
            .owed
            .get(&me)
            .copied()
            .unwrap_or_else(|| env::panic_str("no refund is owed to this account"));
        require!(
            spare() >= amount,
            "the refund is not back with the factory yet; try again in a minute"
        );
        self.owed.remove(&me);
        emit(
            "refund_claimed",
            json!({ "owner": me, "refund": U128(amount.as_yoctonear()) }),
        );
        Promise::new(me).transfer(amount)
    }

    /// What `claim_refund` would pay this account (0 if nothing is owed).
    pub fn refund_owed(&self, account_id: AccountId) -> U128 {
        U128(self.owed.get(&account_id).map_or(0, |n| n.as_yoctonear()))
    }

    /// sha256 (hex) of the code every created contract runs.
    pub fn code_hash(&self) -> String {
        hex(&env::sha256(GUARD_CODE))
    }

    pub fn min_deposit(&self) -> U128 {
        U128(MIN_DEPOSIT.as_yoctonear())
    }

    pub fn max_deposit(&self) -> U128 {
        U128(MAX_DEPOSIT.as_yoctonear())
    }
}

/// Same rule as the console page: 2 to 32 characters, lowercase letters and digits,
/// with single `-` or `_` between them. No dots, so the name is always one level
/// directly under the factory.
pub fn is_label(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < LABEL_MIN || b.len() > LABEL_MAX {
        return false;
    }
    let alnum = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    if !alnum(b[0]) || !alnum(b[b.len() - 1]) {
        return false;
    }
    let mut prev_sep = false;
    for &c in b {
        if alnum(c) {
            prev_sep = false;
        } else if c == b'-' || c == b'_' {
            if prev_sep {
                return false;
            }
            prev_sep = true;
        } else {
            return false;
        }
    }
    true
}

/// Balance the factory can pay out without touching what its own storage needs.
fn spare() -> NearToken {
    let keep = env::storage_byte_cost()
        .saturating_mul((env::storage_usage() + STORAGE_MARGIN_BYTES) as u128);
    env::account_balance().saturating_sub(keep)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let log = json!({ "standard": "cleartopay-factory", "version": "0.1.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

#[cfg(test)]
mod tests;
