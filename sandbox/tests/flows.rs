//! Clear to Pay on a real NEAR node (near-sandbox), end to end.
//!
//! The unit tests run the contract on a mock chain. These deploy the real wasm next to a
//! real NEP-141 token and run the flows that depend on cross-contract calls and on NEAR
//! itself: the deposit hook, a payout and its callback, a payout that fails, the 72-hour
//! wait in block time, and the agent's function-call key being refused by NEAR.
//!
//! Signatures come from the real signing tool (tools/ctp-sign), with its keys in a
//! temporary home folder. Build first, from the repository root:
//!
//!   cargo near build non-reproducible-wasm
//!   (cd sandbox/token && cargo near build non-reproducible-wasm --no-abi)
//!   cargo build --manifest-path tools/ctp-sign/Cargo.toml
//!   (cd sandbox && cargo test -- --test-threads=1)

use anyhow::{Context, Result, bail};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const SUPPLY: &str = "1000000000"; // 1,000 test USDC, 6 decimals
const POOL: u128 = 20_000_000; // 20 test USDC
const PRICE: u128 = 780_000; // 0.78 per tonne

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn wasm(rel: &str) -> Result<Vec<u8>> {
    let p = repo().join(rel);
    std::fs::read(&p).with_context(|| {
        format!(
            "{} not found: build it first (see the top of this file)",
            p.display()
        )
    })
}

/// The real signing tool, with its own key folder for this test run.
struct Signer {
    home: PathBuf,
}

impl Signer {
    fn new(tag: &str) -> Result<Self> {
        let home = std::env::temp_dir().join(format!("ctp-sandbox-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home)?;
        Ok(Self { home })
    }
    fn run(&self, args: &[&str]) -> Result<String> {
        let bin = repo().join("tools/ctp-sign/target/debug/ctp-sign");
        let out = Command::new(&bin)
            .args(args)
            .env("HOME", &self.home)
            .output()
            .with_context(|| {
                format!(
                    "{} not found: cargo build --manifest-path tools/ctp-sign/Cargo.toml",
                    bin.display()
                )
            })?;
        if !out.status.success() {
            bail!(
                "ctp-sign {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        Ok(String::from_utf8(out.stdout)?.trim().to_string())
    }
    fn file(&self, name: &str, body: &str) -> Result<String> {
        let p = self.home.join(name);
        std::fs::write(&p, body)?;
        Ok(p.display().to_string())
    }
    /// submit_invoice arguments for `qty` tonnes paid to `payee`, signed by the supplier
    /// and by the delivery signers listed in `signers` ("storekeeper:storekeeper,...").
    #[allow(clippy::too_many_arguments)]
    fn invoice(
        &self,
        contract: &AccountId,
        token: &AccountId,
        number: &str,
        note_id: &str,
        qty: u64,
        delivered: u64,
        payee: &AccountId,
        signers: &str,
    ) -> Result<Value> {
        let inv = json!({
            "supplier_id": "qingmar-steel", "invoice_number": number, "order_id": "PO-1184", "token": token,
            "lines": [{"sku": "AH36-12mm", "qty": qty.to_string(), "unit_price": PRICE.to_string()}],
            "total": (qty as u128 * PRICE).to_string(),
            "payee": {"chain": "near", "token": token, "address": payee},
        });
        let dlv = json!({"order_id": "PO-1184", "note_id": note_id, "lines": [{"sku": "AH36-12mm", "qty": delivered.to_string()}]});
        let i = self.file(&format!("{number}.json"), &inv.to_string())?;
        let d = self.file(&format!("{note_id}.json"), &dlv.to_string())?;
        let doc = self.file(
            &format!("{number}.txt"),
            &format!("Fictional invoice {number}, {qty} t, for the sandbox test"),
        )?;
        let args = self.run(&[
            "--yes",
            "submit-args",
            "supplier",
            signers,
            contract.as_str(),
            &i,
            &d,
            &doc,
        ])?;
        Ok(serde_json::from_str(&args)?)
    }
}

impl Drop for Signer {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

struct World {
    worker: Worker<Sandbox>,
    guard: Contract,
    usdc: Contract,
    buyer: Account,
    agent: Account,
    qingmar: Account,
    sign: Signer,
}

async fn call(
    from: &Account,
    to: &AccountId,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> Result<Value> {
    let r = from
        .call(to, method)
        .args_json(args)
        .deposit(deposit)
        .max_gas()
        .transact()
        .await?;
    match r.into_result() {
        Ok(ok) => Ok(ok.json::<Value>().unwrap_or(Value::Null)),
        Err(e) => bail!("{method} failed: {e:?}"),
    }
}

async fn view(c: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(c.view(method).args_json(args).await?.json::<Value>()?)
}

async fn balance(w: &World, who: &AccountId) -> Result<u128> {
    let v = view(&w.usdc, "ft_balance_of", json!({"account_id": who})).await?;
    Ok(v.as_str().context("balance")?.parse()?)
}

async fn funds(w: &World) -> Result<(u128, u128)> {
    let f = view(&w.guard, "get_funds", json!({"token": w.usdc.id()})).await?;
    let n = |k: &str| -> Result<u128> { Ok(f[k].as_str().context("funds")?.parse()?) };
    Ok((n("available")?, n("reserved")?))
}

/// The buyer's whole setup, as on testnet: token, pool, supplier, order, limits, two
/// delivery signers and the agent's function-call key. `supplier_on_token` decides
/// whether the supplier can receive the token at all (false = every payout fails).
async fn world(tag: &str, supplier_on_token: bool) -> Result<World> {
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
    let buyer = mk("buyer", 50).await?;
    let qingmar = mk("qingmar", 5).await?;
    let guard = mk("guard", 30)
        .await?
        .deploy(&wasm("target/near/clear_to_pay.wasm")?)
        .await?
        .into_result()?;
    let usdc = mk("usdc", 10)
        .await?
        .deploy(&wasm("sandbox/token/target/near/ctp_test_token.wasm")?)
        .await?
        .into_result()?;
    call(
        guard.as_account(),
        guard.id(),
        "new",
        json!({"owner": buyer.id()}),
        NearToken::from_yoctonear(0),
    )
    .await?;
    call(
        usdc.as_account(),
        usdc.id(),
        "new",
        json!({"owner_id": buyer.id(), "total_supply": SUPPLY}),
        NearToken::from_yoctonear(0),
    )
    .await?;
    let storage = NearToken::from_millinear(10);
    call(
        &buyer,
        usdc.id(),
        "storage_deposit",
        json!({"account_id": guard.id()}),
        storage,
    )
    .await?;
    if supplier_on_token {
        call(
            &buyer,
            usdc.id(),
            "storage_deposit",
            json!({"account_id": qingmar.id()}),
            storage,
        )
        .await?;
    }

    let sign = Signer::new(tag)?;
    let supplier_key = sign.run(&["keygen", "supplier"])?;
    let storekeeper = sign.run(&["keygen", "storekeeper"])?;
    let weighbridge = sign.run(&["keygen", "weighbridge"])?;
    let g = guard.id();
    call(
        &buyer,
        g,
        "allow_token",
        json!({"token": usdc.id()}),
        ONE_YOCTO,
    )
    .await?;
    call(
        &buyer,
        usdc.id(),
        "ft_transfer_call",
        json!({"receiver_id": g, "amount": POOL.to_string(), "msg": ""}),
        ONE_YOCTO,
    )
    .await?;
    call(
        &buyer,
        g,
        "register_supplier",
        json!({"supplier_id": "qingmar-steel", "signing_key": supplier_key,
        "route": {"chain": "near", "token": usdc.id(), "address": qingmar.id()}}),
        ONE_YOCTO,
    )
    .await?;
    call(
        &buyer,
        g,
        "create_order",
        json!({"order_id": "PO-1184", "supplier_id": "qingmar-steel", "token": usdc.id(),
        "lines": [{"sku": "AH36-12mm", "qty": "30", "unit_price": PRICE.to_string()}]}),
        ONE_YOCTO,
    )
    .await?;
    call(
        &buyer,
        g,
        "set_limits",
        json!({"per_invoice": "10000000", "per_supplier_per_period": "30000000",
        "period_hours": "720", "max_submissions_per_day": 100}),
        ONE_YOCTO,
    )
    .await?;
    call(
        &buyer,
        g,
        "add_delivery_signer",
        json!({"key": storekeeper, "role": "storekeeper"}),
        ONE_YOCTO,
    )
    .await?;
    call(
        &buyer,
        g,
        "add_delivery_signer",
        json!({"key": weighbridge, "role": "weighbridge"}),
        ONE_YOCTO,
    )
    .await?;

    // The agent: a function-call key on the buyer's account, for two methods on the guard only.
    let sk = SecretKey::from_random(KeyType::ED25519);
    buyer
        .batch(buyer.id())
        .add_key(
            sk.public_key(),
            AccessKey::function_call_access(
                g,
                &["submit_invoice", "execute_payment"],
                Some(NearToken::from_near(1)),
            ),
        )
        .transact()
        .await?
        .into_result()
        .map_err(|e| anyhow::anyhow!("adding the agent key: {e:?}"))?;
    let agent = Account::from_secret_key(buyer.id().clone(), sk, &worker);
    Ok(World {
        worker,
        guard,
        usdc,
        buyer,
        agent,
        qingmar,
        sign,
    })
}

/// Move block time past the supplier's 72-hour wait.
async fn wait_out_the_72_hours(w: &World) -> Result<()> {
    for _ in 0..12 {
        if !view(
            &w.guard,
            "payable_route",
            json!({"supplier_id": "qingmar-steel"}),
        )
        .await?
        .is_null()
        {
            return Ok(());
        }
        let s = view(
            &w.guard,
            "get_supplier",
            json!({"supplier_id": "qingmar-steel"}),
        )
        .await?;
        let from: u64 = s["route_payable_from"]
            .as_str()
            .context("payable_from")?
            .parse()?;
        let now = w.worker.view_block().await?.timestamp();
        // Sandbox block time is not exactly one second, so ask for twice what is left and check again.
        let blocks = 2 * (from.saturating_sub(now) / 1_000_000_000) + 60;
        w.worker.fast_forward(blocks).await?;
    }
    bail!("the 72-hour wait did not pass after fast-forwarding")
}

async fn submit(w: &World, args: Value) -> Result<Value> {
    call(
        &w.agent,
        w.guard.id(),
        "submit_invoice",
        args,
        NearToken::from_yoctonear(0),
    )
    .await
}

fn reasons(r: &Value) -> Vec<String> {
    r["reasons"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

const BOTH: &str = "storekeeper:storekeeper,weighbridge:weighbridge";

#[tokio::test]
async fn an_honest_invoice_waits_72_hours_then_clears_and_pays_the_registered_address() -> Result<()>
{
    let w = world("honest", true).await?;
    let (g, t, q) = (
        w.guard.id().clone(),
        w.usdc.id().clone(),
        w.qingmar.id().clone(),
    );
    assert_eq!(
        funds(&w).await?,
        (POOL, 0),
        "the deposit hook credited the pool"
    );

    // Before the wait: HELD, nothing moves, and the invoice number stays usable.
    let early = submit(
        &w,
        w.sign
            .invoice(&g, &t, "INV-2208", "DN-552", 10, 10, &q, BOTH)?,
    )
    .await?;
    assert_eq!(early["verdict"], "Held", "{early}");
    assert!(
        reasons(&early).contains(&"payee_not_yet_payable".into()),
        "{early}"
    );
    assert_eq!(balance(&w, &q).await?, 0);

    wait_out_the_72_hours(&w).await?;
    let r = submit(
        &w,
        w.sign
            .invoice(&g, &t, "INV-2208", "DN-552", 10, 10, &q, BOTH)?,
    )
    .await?;
    assert_eq!(r["verdict"], "Cleared", "{r}");
    let id = r["receipt_id"].as_u64().context("receipt id")?;

    // The transfer and its callback ran in the same transaction tree.
    let pay = view(&w.guard, "get_payment", json!({"receipt_id": id})).await?;
    assert_eq!(pay["status"], "Settled", "{pay}");
    assert_eq!(pay["recipient"]["address"], q.as_str());
    assert_eq!(
        balance(&w, &q).await?,
        7_800_000,
        "the supplier received exactly 7.80"
    );
    assert_eq!(
        funds(&w).await?,
        (POOL - 7_800_000, 0),
        "the pool fell by 7.80; nothing left reserved"
    );
    assert_eq!(
        balance(&w, &g).await?,
        POOL - 7_800_000,
        "the contract's own token balance agrees"
    );
    let fl = view(&w.guard, "get_in_flight", json!({"token": t})).await?;
    assert_eq!(fl["payouts"], 0, "{fl}");

    // A paid invoice cannot be paid twice: same number again is SEIZED, no money moves.
    let again = submit(
        &w,
        w.sign
            .invoice(&g, &t, "INV-2208", "DN-553", 10, 10, &q, BOTH)?,
    )
    .await?;
    assert_eq!(again["verdict"], "Seized", "{again}");
    assert_eq!(balance(&w, &q).await?, 7_800_000);
    Ok(())
}

#[tokio::test]
async fn new_bank_details_are_seized_even_with_every_signature_valid() -> Result<()> {
    let w = world("seize", true).await?;
    let (g, t) = (w.guard.id().clone(), w.usdc.id().clone());
    wait_out_the_72_hours(&w).await?;
    let attacker: AccountId = "qingmar-payments.test.near".parse()?;
    let r = submit(
        &w,
        w.sign
            .invoice(&g, &t, "INV-2210", "DN-554", 10, 10, &attacker, BOTH)?,
    )
    .await?;
    assert_eq!(r["verdict"], "Seized", "{r}");
    assert!(reasons(&r).contains(&"payee_mismatch".into()), "{r}");
    assert!(
        r["payment"].is_null(),
        "a seized invoice creates no payment: {r}"
    );
    assert_eq!(funds(&w).await?, (POOL, 0));
    Ok(())
}

#[tokio::test]
async fn one_signer_and_over_billing_are_held_on_chain_too() -> Result<()> {
    let w = world("held", true).await?;
    let (g, t, q) = (
        w.guard.id().clone(),
        w.usdc.id().clone(),
        w.qingmar.id().clone(),
    );
    wait_out_the_72_hours(&w).await?;
    let one = submit(
        &w,
        w.sign.invoice(
            &g,
            &t,
            "INV-3001",
            "DN-601",
            10,
            10,
            &q,
            "storekeeper:storekeeper",
        )?,
    )
    .await?;
    assert_eq!(one["verdict"], "Held", "{one}");
    assert!(
        reasons(&one).contains(&"delivery_signatures_missing".into()),
        "{one}"
    );
    let over = submit(
        &w,
        w.sign
            .invoice(&g, &t, "INV-3002", "DN-602", 12, 10, &q, BOTH)?,
    )
    .await?;
    assert_eq!(over["verdict"], "Held", "{over}");
    assert!(
        reasons(&over).contains(&"quantity_exceeds_delivery".into()),
        "{over}"
    );
    assert_eq!(funds(&w).await?, (POOL, 0));
    assert_eq!(balance(&w, &q).await?, 0);
    Ok(())
}

#[tokio::test]
async fn a_payout_that_fails_returns_the_money_to_the_pool_and_can_be_retried() -> Result<()> {
    // The supplier is not registered with the token, so the token contract refuses the transfer.
    let w = world("fail", false).await?;
    let (g, t, q) = (
        w.guard.id().clone(),
        w.usdc.id().clone(),
        w.qingmar.id().clone(),
    );
    wait_out_the_72_hours(&w).await?;
    let r = submit(
        &w,
        w.sign
            .invoice(&g, &t, "INV-2208", "DN-552", 10, 10, &q, BOTH)?,
    )
    .await?;
    assert_eq!(r["verdict"], "Cleared", "{r}");
    let id = r["receipt_id"].as_u64().context("receipt id")?;
    let pay = view(&w.guard, "get_payment", json!({"receipt_id": id})).await?;
    assert_eq!(
        pay["status"], "Failed",
        "the callback saw the failed transfer: {pay}"
    );
    assert_eq!(
        funds(&w).await?,
        (POOL, 0),
        "every unit is back in the pool, nothing stuck in reserved"
    );
    assert_eq!(balance(&w, &g).await?, POOL);
    assert_eq!(
        view(&w.guard, "get_in_flight", json!({"token": t})).await?["payouts"],
        0
    );

    // The supplier fixes its side; the buyer reauthorises; the new attempt pays.
    call(
        &w.buyer,
        &t,
        "storage_deposit",
        json!({"account_id": q}),
        NearToken::from_millinear(10),
    )
    .await?;
    call(
        &w.buyer,
        &g,
        "reauthorize_payment",
        json!({"receipt_id": id}),
        ONE_YOCTO,
    )
    .await?;
    let pay = view(&w.guard, "get_payment", json!({"receipt_id": id})).await?;
    assert_eq!(pay["status"], "Settled", "{pay}");
    assert_eq!(pay["attempt"], 2);
    assert_eq!(balance(&w, &q).await?, 7_800_000);
    assert_eq!(funds(&w).await?, (POOL - 7_800_000, 0));
    Ok(())
}

#[tokio::test]
async fn near_itself_refuses_what_the_agent_key_must_not_do() -> Result<()> {
    let w = world("fence", true).await?;
    let (g, t) = (w.guard.id().clone(), w.usdc.id().clone());
    // Each of these is refused before or by the chain; none may succeed.
    let tries: Vec<(&str, AccountId, &str, Value, NearToken)> = vec![
        (
            "withdraw the pool",
            g.clone(),
            "withdraw",
            json!({"token": t, "amount": "1000000"}),
            ONE_YOCTO,
        ),
        (
            "change the limits",
            g.clone(),
            "set_limits",
            json!({"per_invoice": "1", "per_supplier_per_period": "1",
            "period_hours": "1", "max_submissions_per_day": 1}),
            NearToken::from_yoctonear(0),
        ),
        (
            "move USDC directly",
            t.clone(),
            "ft_transfer",
            json!({"receiver_id": "qingmar-payments.test.near", "amount": "1"}),
            ONE_YOCTO,
        ),
        (
            "submit with a deposit attached",
            g.clone(),
            "submit_invoice",
            json!({}),
            ONE_YOCTO,
        ),
    ];
    for (what, to, method, args, dep) in tries {
        let r = w
            .agent
            .call(&to, method)
            .args_json(args)
            .deposit(dep)
            .max_gas()
            .transact()
            .await;
        let ok = matches!(&r, Ok(x) if x.is_success());
        assert!(!ok, "the agent key could {what}");
    }
    assert_eq!(funds(&w).await?, (POOL, 0));
    assert_eq!(balance(&w, &g).await?, POOL);
    Ok(())
}

#[tokio::test]
async fn deposits_from_anyone_but_the_buyer_are_sent_back() -> Result<()> {
    let w = world("deposit", true).await?;
    let (g, t, q) = (
        w.guard.id().clone(),
        w.usdc.id().clone(),
        w.qingmar.id().clone(),
    );
    call(
        &w.buyer,
        &t,
        "ft_transfer",
        json!({"receiver_id": q, "amount": "5000000"}),
        ONE_YOCTO,
    )
    .await?;
    call(
        &w.qingmar,
        &t,
        "ft_transfer_call",
        json!({"receiver_id": g, "amount": "5000000", "msg": ""}),
        ONE_YOCTO,
    )
    .await?;
    assert_eq!(
        balance(&w, &q).await?,
        5_000_000,
        "refunded in full by the token's resolve step"
    );
    assert_eq!(funds(&w).await?, (POOL, 0));
    Ok(())
}
