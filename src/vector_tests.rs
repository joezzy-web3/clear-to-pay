//! Golden vectors: the exact digests the contract expects for fixed messages.
//! The signing tool (tools/ctp-sign) asserts the same values, so the two can
//! never silently disagree about what is being signed.

use super::inspection::*;
use super::*;
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

fn sample_route() -> PayoutRoute {
    PayoutRoute { chain: "near".into(), token: "usdc.testnet".into(), address: "qingmar.testnet".into() }
}
fn sample_invoice() -> Invoice {
    Invoice {
        supplier_id: "qingmar-steel".into(),
        invoice_number: "INV-2208".into(),
        order_id: "PO-1184".into(),
        token: "usdc.testnet".into(),
        lines: vec![InvoiceLine { sku: "AH36-12mm".into(), qty: U64(10), unit_price: U128(780_000) }],
        total: U128(7_800_000),
        payee: sample_route(),
    }
}
fn sample_note() -> DeliveryNote {
    DeliveryNote {
        order_id: "PO-1184".into(),
        note_id: "DN-552".into(),
        lines: vec![DeliveredLine { sku: "AH36-12mm".into(), qty: U64(10) }],
    }
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[test]
fn golden_digests() {
    testing_env!(VMContextBuilder::new().build());
    let contract: AccountId = "cleartopay.testnet".parse().unwrap();
    let change = PayoutChangeMessage {
        domain: PAYOUT_CHANGE_DOMAIN.into(),
        contract: contract.clone(),
        supplier_id: "qingmar-steel".into(),
        nonce: 1,
        route: sample_route(),
    }
    .digest();
    let inv = InvoiceMessage { domain: INVOICE_DOMAIN.into(), contract: contract.clone(), invoice: sample_invoice() }.digest();
    let note = DeliveryMessage { domain: DELIVERY_DOMAIN.into(), contract, note: sample_note() }.digest();
    assert_eq!(hex(&change), "452a97d4d4c45de5ce784e89f78fc3845c2cf310551c9397dba7fc66235d9c28");
    assert_eq!(hex(&inv), "192ea978fe7786d96831c3b917bad24d8df73bb3f639d1576a4ed59e7192b487");
    assert_eq!(hex(&note), "5eebe4e05ec41c06b6df02cbca5a350cc35ca0c1bb9880e4ca663ae337097c18");

}
