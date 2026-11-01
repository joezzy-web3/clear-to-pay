//! Registry tests. Each attack test states the trick it tries.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{NearToken, testing_env};

const HOUR: u64 = 60 * 60 * 1_000_000_000;
const T0: u64 = 1_800_000_000 * 1_000_000_000; // a fixed starting time

fn owner() -> AccountId {
    "buyer.testnet".parse().unwrap()
}
fn stranger() -> AccountId {
    "stranger.testnet".parse().unwrap()
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

fn supplier_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn near_pk(k: &SigningKey) -> PublicKey {
    let mut bytes = vec![0u8]; // 0 = ed25519
    bytes.extend_from_slice(k.verifying_key().as_bytes());
    PublicKey::try_from(bytes).unwrap()
}

fn route(addr: &str) -> PayoutRoute {
    PayoutRoute {
        chain: "near".into(),
        token: "usdc.testnet".into(),
        address: addr.into(),
    }
}

fn sign_change(
    k: &SigningKey,
    contract: &AccountId,
    supplier: &str,
    nonce: u64,
    r: &PayoutRoute,
) -> Base64VecU8 {
    let digest = PayoutChangeMessage {
        domain: PAYOUT_CHANGE_DOMAIN.into(),
        contract: contract.clone(),
        supplier_id: supplier.into(),
        nonce,
        route: r.clone(),
    }
    .digest();
    Base64VecU8(k.sign(&digest).to_bytes().to_vec())
}

/// A contract with one supplier ("delta-pumps") registered at T0, signing key seed 7.
fn setup() -> Contract {
    ctx(owner(), T0, 0);
    let mut c = Contract::new(owner());
    ctx(owner(), T0, 1);
    c.register_supplier(
        "delta-pumps".into(),
        near_pk(&supplier_key(7)),
        route("delta-pumps.testnet"),
    );
    c
}

fn propose(c: &mut Contract, at: u64, nonce: u64, r: &PayoutRoute) {
    ctx(stranger(), at, 0); // anyone may relay a signed proposal
    let sig = sign_change(&supplier_key(7), &contract_id(), "delta-pumps", nonce, r);
    c.propose_payout_change("delta-pumps".into(), r.clone(), U64(nonce), sig);
}

fn payable_at(c: &Contract, at: u64) -> Option<PayoutRoute> {
    ctx(stranger(), at, 0);
    c.payable_route("delta-pumps".into())
}

// ------------------------------------------------------------------ registration

#[test]
fn init_sets_owner_and_starts_unpaused() {
    ctx(owner(), T0, 0);
    let c = Contract::new(owner());
    assert_eq!(c.get_owner(), owner());
    assert!(!c.is_paused());
}

#[test]
fn new_supplier_is_not_payable_for_72_hours() {
    let c = setup();
    assert_eq!(payable_at(&c, T0), None);
    assert_eq!(payable_at(&c, T0 + 72 * HOUR - 1), None);
    assert_eq!(
        payable_at(&c, T0 + 72 * HOUR),
        Some(route("delta-pumps.testnet"))
    );
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn stranger_cannot_register_a_supplier() {
    let mut c = setup();
    ctx(stranger(), T0, 1);
    c.register_supplier(
        "fake-co".into(),
        near_pk(&supplier_key(9)),
        route("attacker.testnet"),
    );
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_actions_need_one_yocto_so_a_limited_key_cannot_call_them() {
    let mut c = setup();
    ctx(owner(), T0, 0);
    c.register_supplier(
        "other".into(),
        near_pk(&supplier_key(9)),
        route("other.testnet"),
    );
}

#[test]
#[should_panic(expected = "supplier already registered")]
fn registering_twice_cannot_overwrite_a_supplier() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.register_supplier(
        "delta-pumps".into(),
        near_pk(&supplier_key(9)),
        route("attacker.testnet"),
    );
}

#[test]
#[should_panic(expected = "supplier id may only use")]
fn supplier_ids_with_lookalike_letters_are_rejected() {
    ctx(owner(), T0, 0);
    let mut c = Contract::new(owner());
    ctx(owner(), T0, 1);
    // Cyrillic 'а' (U+0430) instead of Latin 'a'
    c.register_supplier(
        "delt\u{0430}-pumps".into(),
        near_pk(&supplier_key(7)),
        route("delta-pumps.testnet"),
    );
}

#[test]
#[should_panic(expected = "route address must be")]
fn addresses_with_invisible_characters_are_rejected() {
    ctx(owner(), T0, 0);
    let mut c = Contract::new(owner());
    ctx(owner(), T0, 1);
    // zero-width space hidden inside the address
    c.register_supplier(
        "delta-pumps".into(),
        near_pk(&supplier_key(7)),
        route("delta\u{200B}pumps.testnet"),
    );
}

#[test]
fn registration_emits_an_event() {
    setup();
    let logs = get_logs();
    assert!(
        logs.iter()
            .any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"supplier_registered\""))
    );
}

// ------------------------------------------------------------------ payout changes

#[test]
fn signed_approved_change_takes_effect_72_hours_after_proposal() {
    let mut c = setup();
    let t1 = T0 + 100 * HOUR; // original route is live by now
    let new = route("delta-pumps-new.testnet");
    propose(&mut c, t1, 1, &new);
    ctx(owner(), t1 + HOUR, 1);
    c.approve_payout_change("delta-pumps".into());

    // While pending, the old route stays payable and the new one does not.
    assert_eq!(
        payable_at(&c, t1 + 72 * HOUR - 1),
        Some(route("delta-pumps.testnet"))
    );
    // From exactly 72 hours after the proposal, only the new route is payable.
    assert_eq!(payable_at(&c, t1 + 72 * HOUR), Some(new.clone()));
    ctx(stranger(), t1 + 72 * HOUR, 0);
    assert!(!c.is_payable("delta-pumps".into(), route("delta-pumps.testnet")));
    assert!(c.is_payable("delta-pumps".into(), new));
}

#[test]
fn unapproved_change_never_takes_effect() {
    let mut c = setup();
    let t1 = T0 + 100 * HOUR;
    propose(&mut c, t1, 1, &route("delta-pumps-new.testnet"));
    assert_eq!(
        payable_at(&c, t1 + 1000 * HOUR),
        Some(route("delta-pumps.testnet"))
    );
}

#[test]
fn approving_late_does_not_skip_the_wait_and_approving_early_does_not_shorten_it() {
    let mut c = setup();
    let t1 = T0 + 100 * HOUR;
    let new = route("delta-pumps-new.testnet");
    propose(&mut c, t1, 1, &new);
    ctx(owner(), t1, 1); // approved immediately
    c.approve_payout_change("delta-pumps".into());
    assert_eq!(
        payable_at(&c, t1 + 71 * HOUR),
        Some(route("delta-pumps.testnet"))
    );
    assert_eq!(payable_at(&c, t1 + 72 * HOUR), Some(new));
}

#[test]
#[should_panic(expected = "invalid supplier signature")]
fn attack_change_signed_by_the_wrong_key_is_rejected() {
    let mut c = setup();
    let r = route("attacker.testnet");
    ctx(stranger(), T0 + 100 * HOUR, 0);
    let sig = sign_change(&supplier_key(66), &contract_id(), "delta-pumps", 1, &r);
    c.propose_payout_change("delta-pumps".into(), r, U64(1), sig);
}

#[test]
#[should_panic(expected = "invalid supplier signature")]
fn attack_swapping_the_address_after_signing_is_rejected() {
    let mut c = setup();
    ctx(stranger(), T0 + 100 * HOUR, 0);
    let sig = sign_change(
        &supplier_key(7),
        &contract_id(),
        "delta-pumps",
        1,
        &route("delta-pumps-new.testnet"),
    );
    c.propose_payout_change("delta-pumps".into(), route("attacker.testnet"), U64(1), sig);
}

#[test]
#[should_panic(expected = "invalid supplier signature")]
fn attack_signature_made_for_another_contract_is_rejected() {
    let mut c = setup();
    let r = route("delta-pumps-new.testnet");
    ctx(stranger(), T0 + 100 * HOUR, 0);
    let other: AccountId = "some-other-app.testnet".parse().unwrap();
    let sig = sign_change(&supplier_key(7), &other, "delta-pumps", 1, &r);
    c.propose_payout_change("delta-pumps".into(), r, U64(1), sig);
}

#[test]
#[should_panic(expected = "nonce already used")]
fn attack_replaying_an_old_signed_change_is_rejected() {
    let mut c = setup();
    let t1 = T0 + 100 * HOUR;
    let old = route("delta-pumps-old-bank.testnet");
    propose(&mut c, t1, 1, &old);
    propose(&mut c, t1 + HOUR, 2, &route("delta-pumps-new.testnet"));
    // An attacker who saved the first signed message tries to replay it.
    propose(&mut c, t1 + 2 * HOUR, 1, &old);
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn stranger_cannot_approve_a_change() {
    let mut c = setup();
    propose(
        &mut c,
        T0 + 100 * HOUR,
        1,
        &route("delta-pumps-new.testnet"),
    );
    ctx(stranger(), T0 + 101 * HOUR, 1);
    c.approve_payout_change("delta-pumps".into());
}

#[test]
fn owner_can_cancel_a_pending_change() {
    let mut c = setup();
    let t1 = T0 + 100 * HOUR;
    propose(&mut c, t1, 1, &route("delta-pumps-new.testnet"));
    ctx(owner(), t1 + HOUR, 1);
    c.approve_payout_change("delta-pumps".into());
    ctx(owner(), t1 + 2 * HOUR, 1);
    c.cancel_payout_change("delta-pumps".into());
    assert_eq!(
        payable_at(&c, t1 + 500 * HOUR),
        Some(route("delta-pumps.testnet"))
    );
}

#[test]
fn a_new_signed_proposal_restarts_the_clock() {
    let mut c = setup();
    let t1 = T0 + 100 * HOUR;
    propose(&mut c, t1, 1, &route("delta-pumps-a.testnet"));
    ctx(owner(), t1, 1);
    c.approve_payout_change("delta-pumps".into());
    // 70 hours later a different change arrives: it replaces the first and needs fresh approval and a fresh 72 hours.
    let b = route("delta-pumps-b.testnet");
    propose(&mut c, t1 + 70 * HOUR, 2, &b);
    assert_eq!(
        payable_at(&c, t1 + 72 * HOUR),
        Some(route("delta-pumps.testnet"))
    );
    ctx(owner(), t1 + 71 * HOUR, 1);
    c.approve_payout_change("delta-pumps".into());
    assert_eq!(
        payable_at(&c, t1 + 70 * HOUR + 72 * HOUR - 1),
        Some(route("delta-pumps.testnet"))
    );
    assert_eq!(payable_at(&c, t1 + 70 * HOUR + 72 * HOUR), Some(b));
}

#[test]
fn unknown_supplier_has_no_payable_route() {
    let c = setup();
    ctx(stranger(), T0 + 1000 * HOUR, 0);
    assert_eq!(c.payable_route("nobody".into()), None);
    assert!(!c.is_payable("nobody".into(), route("attacker.testnet")));
}

// ------------------------------------------------------------------ pause

#[test]
#[should_panic(expected = "only the owner can do this")]
fn stranger_cannot_pause() {
    let mut c = setup();
    ctx(stranger(), T0, 1);
    c.pause();
}

#[test]
#[should_panic(expected = "contract is paused")]
fn pause_blocks_new_proposals() {
    let mut c = setup();
    ctx(owner(), T0, 1);
    c.pause();
    propose(
        &mut c,
        T0 + 100 * HOUR,
        1,
        &route("delta-pumps-new.testnet"),
    );
}

#[test]
fn cancel_still_works_while_paused_and_unpause_restores_activity() {
    let mut c = setup();
    let t1 = T0 + 100 * HOUR;
    propose(&mut c, t1, 1, &route("delta-pumps-new.testnet"));
    ctx(owner(), t1, 1);
    c.pause();
    ctx(owner(), t1, 1);
    c.cancel_payout_change("delta-pumps".into());
    ctx(owner(), t1, 1);
    c.unpause();
    assert!(!c.is_paused());
    propose(&mut c, t1 + HOUR, 2, &route("delta-pumps-new.testnet"));
}

#[test]
fn view_shows_route_on_file_pending_change_and_nonce() {
    let mut c = setup();
    let t1 = T0 + 100 * HOUR;
    propose(&mut c, t1, 5, &route("delta-pumps-new.testnet"));
    ctx(stranger(), t1, 0);
    let v = c.get_supplier("delta-pumps".into()).unwrap();
    assert_eq!(v.payable_route, Some(route("delta-pumps.testnet")));
    assert_eq!(
        v.pending.as_ref().unwrap().route,
        route("delta-pumps-new.testnet")
    );
    assert!(!v.pending.unwrap().approved);
    assert_eq!(v.last_nonce, U64(5));
}

/// Watchers read every supplier from the contract; suppliers from before the index can be added.
#[test]
fn every_registered_supplier_is_listed_once() {
    let mut c = setup();
    assert_eq!(c.get_supplier_ids(), vec!["delta-pumps".to_string()]);
    ctx(owner(), T0, 1);
    c.index_supplier("delta-pumps".into());
    assert_eq!(c.get_supplier_ids(), vec!["delta-pumps".to_string()]);
}
