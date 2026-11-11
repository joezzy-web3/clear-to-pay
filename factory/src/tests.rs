use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

fn factory_id() -> AccountId {
    "factory.cleartopay.testnet".parse().unwrap()
}
fn buyer() -> AccountId {
    "buyer.testnet".parse().unwrap()
}
fn builder(caller: AccountId, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(factory_id())
        .predecessor_account_id(caller.clone())
        .signer_account_id(caller)
        .attached_deposit(deposit);
    b
}
fn call(caller: AccountId, deposit: NearToken) {
    testing_env!(builder(caller, deposit).build());
}
/// The factory's own balance in a test: 10 NEAR, with ~340 KB of its storage in use.
fn funded(b: &mut VMContextBuilder, balance: NearToken) -> &mut VMContextBuilder {
    b.account_balance(balance).storage_usage(340_000)
}
fn callback(result: Option<PromiseResult>) {
    callback_with(result, NearToken::from_near(10));
}
fn callback_with(result: Option<PromiseResult>, balance: NearToken) {
    let mut b = builder(factory_id(), NearToken::from_yoctonear(0));
    testing_env!(
        funded(&mut b, balance).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        result.into_iter().collect()
    );
}

/// Every action created in this test, flattened: (receiver, short description).
fn actions() -> Vec<(String, String)> {
    let mut out = vec![];
    for r in get_created_receipts() {
        let to = r.receiver_id.to_string();
        for a in r.actions {
            let d = match a {
                MockAction::CreateAccount { .. } => "create_account".to_string(),
                MockAction::Transfer { deposit, .. } => {
                    format!("transfer {}", deposit.as_yoctonear())
                }
                MockAction::DeployContract { code, .. } => {
                    assert!(code == GUARD_CODE, "deployed code must be the guard code");
                    "deploy guard".to_string()
                }
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    ..
                } => format!(
                    "call {} {} {}",
                    String::from_utf8_lossy(&method_name),
                    String::from_utf8_lossy(&args),
                    attached_deposit.as_yoctonear()
                ),
                other => format!("UNEXPECTED {other:?}"),
            };
            out.push((to.clone(), d));
        }
    }
    out
}

fn panics(f: impl FnOnce() + std::panic::UnwindSafe) -> String {
    let e = std::panic::catch_unwind(f).expect_err("expected a panic");
    e.downcast_ref::<String>()
        .cloned()
        .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

// ------------------------------------------------------------------ the embedded code

#[test]
fn embedded_code_is_the_deployed_guard() {
    call(buyer(), NearToken::from_yoctonear(0));
    assert_eq!(hex(&env::sha256(GUARD_CODE)), GUARD_CODE_SHA256);
    assert_eq!(Factory::default().code_hash(), GUARD_CODE_SHA256);
    // A wasm file starts with "\0asm".
    assert_eq!(&GUARD_CODE[..4], b"\0asm");
}

#[test]
fn deposit_bounds_are_visible() {
    call(buyer(), NearToken::from_yoctonear(0));
    let f = Factory::default();
    assert_eq!(f.min_deposit().0, 3_600_000_000_000_000_000_000_000);
    assert_eq!(f.max_deposit().0, 5_000_000_000_000_000_000_000_000);
    // The code's storage alone must fit in the minimum, with room to spare.
    let storage = GUARD_CODE.len() as u128 * 10_000_000_000_000_000_000; // 1e19 yocto per byte
    assert!(storage + 200_000_000_000_000_000_000_000 < MIN_DEPOSIT.as_yoctonear());
}

// ------------------------------------------------------------------------- labels

#[test]
fn labels() {
    for ok in [
        "ab",
        "acme",
        "acme-foods",
        "acme_2",
        "a1",
        "x".repeat(32).as_str(),
    ] {
        assert!(is_label(ok), "{ok} should be allowed");
    }
    for bad in [
        "",
        "a",
        "Acme",
        "acme.foods",
        "-acme",
        "acme-",
        "ac--me",
        "ac-_me",
        "ac me",
        "acmé",
        "x".repeat(33).as_str(),
        "_a",
    ] {
        assert!(!is_label(bad), "{bad:?} should be refused");
    }
}

// ------------------------------------------------------------------------- create

#[test]
fn create_builds_one_keyless_batch_then_the_callback() {
    call(buyer(), MIN_DEPOSIT);
    let _ = Factory::default().create("acme".into());
    let got = actions();
    let name = "acme.factory.cleartopay.testnet".to_string();
    let f = factory_id().to_string();
    assert_eq!(
        got,
        vec![
            (name.clone(), "create_account".into()),
            (
                name.clone(),
                format!("transfer {}", MIN_DEPOSIT.as_yoctonear())
            ),
            (name.clone(), "deploy guard".into()),
            (
                name.clone(),
                r#"call new {"owner":"buyer.testnet"} 0"#.into()
            ),
            (
                f,
                format!(
                    r#"call on_created {{"new_account":"{name}","owner":"buyer.testnet","deposit":"{}"}} 0"#,
                    MIN_DEPOSIT.as_yoctonear()
                )
            ),
        ]
    );
    // No access key anywhere: the new contract is locked from birth.
    assert!(got.iter().all(|(_, d)| !d.contains("UNEXPECTED")));
    assert!(get_logs()[0].contains("create_started"));
}

#[test]
fn owner_is_always_the_caller() {
    let someone: AccountId = "someone.testnet".parse().unwrap();
    call(someone, NearToken::from_near(4));
    let _ = Factory::default().create("acme".into());
    assert!(
        actions()
            .iter()
            .any(|(_, d)| d == r#"call new {"owner":"someone.testnet"} 0"#)
    );
}

#[test]
fn create_refuses_bad_input() {
    let cases: Vec<(&str, NearToken, &str)> = vec![
        ("acme", NearToken::from_yoctonear(0), "at least 3.6 NEAR"),
        (
            "acme",
            NearToken::from_yoctonear(MIN_DEPOSIT.as_yoctonear() - 1),
            "at least 3.6 NEAR",
        ),
        (
            "acme",
            NearToken::from_yoctonear(MAX_DEPOSIT.as_yoctonear() + 1),
            "at most 5 NEAR",
        ),
        ("Acme", MIN_DEPOSIT, "label"),
        ("a.b", MIN_DEPOSIT, "label"),
        ("", MIN_DEPOSIT, "label"),
        ("guard", MIN_DEPOSIT, "reserved"),
        ("cleartopay", MIN_DEPOSIT, "reserved"),
    ];
    for (label, deposit, msg) in cases {
        let label = label.to_string();
        let e = panics(move || {
            call(buyer(), deposit);
            let _ = Factory::default().create(label);
        });
        assert!(e.contains(msg), "expected {msg:?}, got {e:?}");
    }
}

#[test]
fn exact_bounds_are_allowed() {
    for d in [MIN_DEPOSIT, MAX_DEPOSIT] {
        call(buyer(), d);
        let _ = Factory::default().create("acme".into());
    }
}

// ----------------------------------------------------------------------- callback

#[test]
fn success_keeps_the_deposit_on_the_new_contract() {
    callback(Some(PromiseResult::Successful(vec![])));
    let r = Factory::default().on_created(
        "acme.factory.cleartopay.testnet".parse().unwrap(),
        buyer(),
        U128(MIN_DEPOSIT.as_yoctonear()),
    );
    assert!(matches!(r, PromiseOrValue::Value(true)));
    assert!(actions().is_empty(), "nothing is sent anywhere on success");
    assert!(get_logs()[0].contains("contract_created"));
}

#[test]
fn failure_refunds_the_caller_in_full() {
    callback(Some(PromiseResult::Failed));
    let r = Factory::default().on_created(
        "acme.factory.cleartopay.testnet".parse().unwrap(),
        buyer(),
        U128(MIN_DEPOSIT.as_yoctonear()),
    );
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    drop(r);
    assert_eq!(
        actions(),
        vec![(
            "buyer.testnet".to_string(),
            format!("transfer {}", MIN_DEPOSIT.as_yoctonear())
        )]
    );
    assert!(get_logs()[0].contains("create_failed_refunded"));
}

#[test]
fn callback_needs_exactly_one_result() {
    let e = panics(|| {
        callback(None);
        let _ = Factory::default().on_created(
            "acme.factory.cleartopay.testnet".parse().unwrap(),
            buyer(),
            U128(1),
        );
    });
    assert!(e.contains("only runs after a create batch"), "{e}");
}

#[test]
fn a_refund_the_factory_cannot_pay_yet_is_owed_not_lost() {
    // 3.5 NEAR of storage in use, 5 NEAR balance: only ~1.5 NEAR spare, less than 3.6.
    let mut f = Factory::default();
    callback_with(Some(PromiseResult::Failed), NearToken::from_near(5));
    let r = f.on_created(
        "acme.factory.cleartopay.testnet".parse().unwrap(),
        buyer(),
        U128(MIN_DEPOSIT.as_yoctonear()),
    );
    assert!(matches!(r, PromiseOrValue::Value(false)));
    assert!(
        actions().is_empty(),
        "nothing is sent while the money is not back"
    );
    assert!(get_logs()[0].contains("create_failed_refund_owed"));
    assert_eq!(f.refund_owed(buyer()).0, MIN_DEPOSIT.as_yoctonear());

    // A second failed attempt adds up.
    callback_with(Some(PromiseResult::Failed), NearToken::from_near(5));
    let _ = f.on_created(
        "acme2.factory.cleartopay.testnet".parse().unwrap(),
        buyer(),
        U128(MIN_DEPOSIT.as_yoctonear()),
    );
    let both = 2 * MIN_DEPOSIT.as_yoctonear();
    assert_eq!(f.refund_owed(buyer()).0, both);

    // Too early: the money is not back yet.
    let mut b = builder(buyer(), NearToken::from_yoctonear(0));
    testing_env!(funded(&mut b, NearToken::from_near(5)).build());
    let e = panics(std::panic::AssertUnwindSafe(|| {
        let _ = f.claim_refund();
    }));
    assert!(e.contains("not back with the factory yet"), "{e}");

    // Back: paid once, to the caller only, then nothing more.
    let mut b = builder(buyer(), NearToken::from_yoctonear(0));
    testing_env!(funded(&mut b, NearToken::from_near(20)).build());
    drop(f.claim_refund());
    assert_eq!(
        actions(),
        vec![("buyer.testnet".to_string(), format!("transfer {both}"))]
    );
    assert_eq!(f.refund_owed(buyer()).0, 0);
    let e = panics(std::panic::AssertUnwindSafe(|| {
        let _ = f.claim_refund();
    }));
    assert!(e.contains("no refund is owed"), "{e}");
}

#[test]
fn nobody_else_can_claim_a_refund() {
    let mut f = Factory::default();
    callback_with(Some(PromiseResult::Failed), NearToken::from_near(5));
    let _ = f.on_created(
        "acme.factory.cleartopay.testnet".parse().unwrap(),
        buyer(),
        U128(MIN_DEPOSIT.as_yoctonear()),
    );
    let thief: AccountId = "thief.testnet".parse().unwrap();
    let mut b = builder(thief, NearToken::from_yoctonear(0));
    testing_env!(funded(&mut b, NearToken::from_near(20)).build());
    let e = panics(std::panic::AssertUnwindSafe(|| {
        let _ = f.claim_refund();
    }));
    assert!(e.contains("no refund is owed"), "{e}");
    assert_eq!(f.refund_owed(buyer()).0, MIN_DEPOSIT.as_yoctonear());
}
