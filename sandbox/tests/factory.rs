//! The factory on a real NEAR node: a buyer creates their own Clear to Pay contract with
//! one ordinary call, and every way that can go wrong leaves the buyer whole.
//!
//! Build first, from the repository root:
//!
//!   (cd factory && cargo near build non-reproducible-wasm)
//!   (cd sandbox && cargo test --test factory -- --nocapture)
//!
//! The factory embeds factory/res/clear_to_pay.wasm (the code deployed on testnet).

use anyhow::{Context, Result, bail};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker, network::Sandbox};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const DEPOSIT: NearToken = NearToken::from_millinear(3_600);

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn file(rel: &str) -> Result<Vec<u8>> {
    let p = repo().join(rel);
    std::fs::read(&p).with_context(|| format!("{} not found: build it first", p.display()))
}

struct World {
    worker: Worker<Sandbox>,
    factory: Contract,
    buyer: Account,
    other: Account,
}

async fn world() -> Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let mk = |name: &'static str, near: u128| {
        let root = root.clone();
        async move {
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(near))
                .transact()
                .await?
                .into_result()
                .map_err(|e| anyhow::anyhow!("{e:?}"))
        }
    };
    let factory = mk("factory", 15)
        .await?
        .deploy(&file("factory/target/near/ctp_factory.wasm")?)
        .await?
        .into_result()?;
    let buyer = mk("buyer", 20).await?;
    let other = mk("other", 20).await?;
    Ok(World {
        worker,
        factory,
        buyer,
        other,
    })
}

async fn create(w: &World, who: &Account, label: &str, deposit: NearToken) -> Result<bool> {
    let r = who
        .call(w.factory.id(), "create")
        .args_json(json!({ "label": label }))
        .deposit(deposit)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    for l in r.logs() {
        println!("  log: {l}");
    }
    // The outer call succeeds whenever the batch was scheduled; what happened to the
    // batch is in the callback's events.
    if !r.is_success() {
        return Ok(false);
    }
    let logs = r.logs().join("\n");
    Ok(logs.contains("\"contract_created\""))
}

/// A balance after every refund receipt has landed: NEAR reports a transaction done
/// before its refunds arrive, so let a few blocks pass first.
async fn liquid(w: &World, id: &AccountId) -> Result<u128> {
    w.worker.fast_forward(3).await?;
    Ok(w.worker.view_account(id).await?.balance.as_yoctonear())
}

fn child(w: &World, label: &str) -> AccountId {
    format!("{label}.{}", w.factory.id()).parse().unwrap()
}

#[tokio::test]
async fn buyer_creates_a_locked_contract_they_own() -> Result<()> {
    let w = world().await?;
    let before = liquid(&w, w.buyer.id()).await?;

    assert!(
        create(&w, &w.buyer, "acme", DEPOSIT).await?,
        "create should succeed"
    );
    let acme = child(&w, "acme");

    // Exactly the embedded guard code.
    let code = w.worker.view_code(&acme).await?;
    assert!(
        code == file("factory/res/clear_to_pay.wasm")?,
        "deployed code differs"
    );
    let hash: Value = w.factory.view("code_hash").await?.json()?;
    let owed: Value = w
        .factory
        .view("refund_owed")
        .args_json(json!({ "account_id": w.buyer.id() }))
        .await?
        .json()?;
    assert_eq!(owed, json!("0"));
    assert_eq!(
        hash,
        json!("9b998038ac549a37c871c431e28b125437f4c7f046799d8e4e5c139dbea0a2d1")
    );

    // Owned by the caller, with no key at all.
    let owner: Value = w.worker.view(&acme, "get_owner").await?.json()?;
    assert_eq!(owner, json!(w.buyer.id()));
    let keys = w.worker.view_access_keys(&acme).await?;
    assert!(
        keys.is_empty(),
        "the created contract must have no keys: {keys:?}"
    );

    // The buyer paid the deposit plus gas, nothing more.
    let spent = before - liquid(&w, w.buyer.id()).await?;
    assert!(spent >= DEPOSIT.as_yoctonear());
    assert!(spent < DEPOSIT.as_yoctonear() + NEAR / 10, "spent {spent}");

    // It really runs: the owner can pause it, someone else cannot.
    let r = w
        .other
        .call(&acme, "pause")
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(
        r.is_failure(),
        "a stranger must not control the new contract"
    );
    let r = w
        .buyer
        .call(&acme, "pause")
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    if !r.is_success() {
        bail!("owner could not pause: {:?}", r.into_result().err());
    }
    Ok(())
}

#[tokio::test]
async fn a_taken_name_refunds_the_buyer_in_full() -> Result<()> {
    let w = world().await?;
    assert!(create(&w, &w.buyer, "acme", DEPOSIT).await?);
    let factory_before = liquid(&w, w.factory.id()).await?;
    let other_before = liquid(&w, w.other.id()).await?;

    // Someone else tries the same name: nothing is created, the deposit comes back.
    assert!(!create(&w, &w.other, "acme", DEPOSIT).await?);
    let spent = other_before - liquid(&w, w.other.id()).await?;
    assert!(spent < NEAR / 10, "lost more than gas: {spent}");

    // The first contract is untouched: still the buyer's.
    let owner: Value = w
        .worker
        .view(&child(&w, "acme"), "get_owner")
        .await?
        .json()?;
    assert_eq!(owner, json!(w.buyer.id()));

    // The factory ends where it started, give or take gas rewards.
    let factory_after = liquid(&w, w.factory.id()).await?;
    assert!(
        factory_after + NEAR / 100 >= factory_before,
        "factory lost NEAR: {factory_before} -> {factory_after}"
    );
    Ok(())
}

#[tokio::test]
async fn bad_requests_are_refused_and_cost_only_gas() -> Result<()> {
    let w = world().await?;
    let before = liquid(&w, w.buyer.id()).await?;
    for (label, deposit) in [
        ("acme", NearToken::from_millinear(3_599)),
        ("acme", NearToken::from_millinear(5_001)),
        ("Acme", DEPOSIT),
        ("a.b", DEPOSIT),
        ("x", DEPOSIT),
        ("guard", DEPOSIT),
    ] {
        assert!(
            !create(&w, &w.buyer, label, deposit).await?,
            "{label} {deposit} must fail"
        );
    }
    let spent = before - liquid(&w, w.buyer.id()).await?;
    assert!(spent < NEAR / 10, "lost more than gas: {spent}");
    assert!(w.worker.view_account(&child(&w, "acme")).await.is_err());
    Ok(())
}

#[tokio::test]
async fn only_the_factory_can_report_results() -> Result<()> {
    let w = world().await?;
    // A stranger calling the callback directly to get a "refund" out of the factory.
    let before = liquid(&w, w.factory.id()).await?;
    let r = w
        .buyer
        .call(w.factory.id(), "on_created")
        .args_json(json!({
            "new_account": child(&w, "acme"),
            "owner": w.buyer.id(),
            "deposit": DEPOSIT.as_yoctonear().to_string(),
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure(), "on_created must be private");
    // Nor can anyone claim a refund that was never owed.
    let r = w
        .buyer
        .call(w.factory.id(), "claim_refund")
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure(), "nothing is owed, so nothing can be claimed");
    assert!(liquid(&w, w.factory.id()).await? + NEAR / 100 >= before);
    Ok(())
}
