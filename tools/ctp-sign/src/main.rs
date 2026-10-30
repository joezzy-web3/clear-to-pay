//! ctp-sign: plays the supplier and the storekeeper for the Clear to Pay demo.
//!
//! It creates ed25519 keys and signs invoices, delivery notes and payout changes
//! in exactly the bytes the contract verifies (borsh, then sha-256, then ed25519).
//! Golden-vector tests pin those bytes to the contract's own tests.
//!
//! Keys live in ~/.config/clear-to-pay/keys, outside the repository, readable
//! only by you. Existing keys are never overwritten.
//!
//! Before signing, it prints what is about to be signed (payee, total, lines)
//! and asks for confirmation. --yes skips the question, for scripts.
//! The supplier and storekeeper keys must be different keys.
//!
//! Usage:
//!   ctp-sign keygen <name>
//!   ctp-sign pubkey <name>
//!   ctp-sign hash <file>
//!   ctp-sign [--yes] payout-change <key> <contract> <supplier_id> <nonce> <route.json>
//!   ctp-sign [--yes] submit-args <supplier_key> <storekeeper_key> <contract> <invoice.json> <delivery.json> <document>

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use borsh::BorshSerialize;
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::io::{BufRead, IsTerminal};
use std::path::PathBuf;
use std::{env, fs, io, process};

const PAYOUT_CHANGE_DOMAIN: &str = "clear-to-pay/payout-change/v1";
const INVOICE_DOMAIN: &str = "clear-to-pay/invoice/v1";
const DELIVERY_DOMAIN: &str = "clear-to-pay/delivery/v1";

// ------------------------------------------------------------------ the signed shapes
// Field order matters: it must match the contract's structs exactly.

#[derive(BorshSerialize, Deserialize, Serialize, Clone, Debug)]
struct PayoutRoute {
    chain: String,
    token: String,
    address: String,
}

#[derive(BorshSerialize, Deserialize, Serialize, Clone, Debug)]
struct InvoiceLine {
    sku: String,
    #[serde(deserialize_with = "u64_str", serialize_with = "to_str")]
    qty: u64,
    #[serde(deserialize_with = "u128_str", serialize_with = "to_str")]
    unit_price: u128,
}

#[derive(BorshSerialize, Deserialize, Serialize, Clone, Debug)]
struct Invoice {
    supplier_id: String,
    invoice_number: String,
    order_id: String,
    token: String,
    lines: Vec<InvoiceLine>,
    #[serde(deserialize_with = "u128_str", serialize_with = "to_str")]
    total: u128,
    payee: PayoutRoute,
}

#[derive(BorshSerialize, Deserialize, Serialize, Clone, Debug)]
struct DeliveredLine {
    sku: String,
    #[serde(deserialize_with = "u64_str", serialize_with = "to_str")]
    qty: u64,
}

#[derive(BorshSerialize, Deserialize, Serialize, Clone, Debug)]
struct DeliveryNote {
    order_id: String,
    note_id: String,
    lines: Vec<DeliveredLine>,
}

#[derive(BorshSerialize)]
struct PayoutChangeMessage<'a> {
    domain: &'a str,
    contract: &'a str,
    supplier_id: &'a str,
    nonce: u64,
    route: &'a PayoutRoute,
}

#[derive(BorshSerialize)]
struct InvoiceMessage<'a> {
    domain: &'a str,
    contract: &'a str,
    invoice: &'a Invoice,
    /// sha-256 of the invoice document, signed so nobody else can claim it.
    document_hash: [u8; 32],
}

#[derive(BorshSerialize)]
struct DeliveryMessage<'a> {
    domain: &'a str,
    contract: &'a str,
    note: &'a DeliveryNote,
}

fn digest<T: BorshSerialize>(m: &T) -> [u8; 32] {
    Sha256::digest(borsh::to_vec(m).expect("encodes")).into()
}

// Contract JSON writes 64- and 128-bit numbers as strings ("7800000").
fn u64_str<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    String::deserialize(d)?
        .parse()
        .map_err(serde::de::Error::custom)
}
fn u128_str<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
    String::deserialize(d)?
        .parse()
        .map_err(serde::de::Error::custom)
}
fn to_str<T: ToString, S: serde::Serializer>(v: &T, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&v.to_string())
}

// ------------------------------------------------------------------ keys

fn key_dir() -> PathBuf {
    let home = env::var("HOME").unwrap_or_else(|_| die("HOME is not set"));
    PathBuf::from(home).join(".config/clear-to-pay/keys")
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn key_path(name: &str) -> PathBuf {
    if !valid_name(name) {
        die("key names may only use letters, digits, '-' and '_'");
    }
    key_dir().join(format!("{name}.json"))
}

#[derive(Serialize, Deserialize)]
struct KeyFile {
    public_key: String,
    secret_key: String,
}

fn near_public(k: &SigningKey) -> String {
    format!(
        "ed25519:{}",
        bs58::encode(k.verifying_key().as_bytes()).into_string()
    )
}

fn keygen(name: &str) {
    let path = key_path(name);
    if path.exists() {
        die(&format!(
            "{} already exists; refusing to overwrite a key",
            path.display()
        ));
    }
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).unwrap_or_else(|_| die("no secure randomness available"));
    let k = SigningKey::from_bytes(&seed);
    let file = KeyFile {
        public_key: near_public(&k),
        secret_key: format!(
            "ed25519:{}",
            bs58::encode(k.to_keypair_bytes()).into_string()
        ),
    };
    fs::create_dir_all(key_dir()).unwrap_or_else(|e| die(&e.to_string()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(key_dir(), fs::Permissions::from_mode(0o700));
    }
    fs::write(&path, serde_json::to_string_pretty(&file).unwrap())
        .unwrap_or_else(|e| die(&e.to_string()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    println!("{}", file.public_key);
}

fn load(name: &str) -> SigningKey {
    let raw = fs::read_to_string(key_path(name)).unwrap_or_else(|_| {
        die(&format!(
            "no key named '{name}'; run: ctp-sign keygen {name}"
        ))
    });
    let file: KeyFile = serde_json::from_str(&raw).unwrap_or_else(|_| die("key file is damaged"));
    let bytes = bs58::decode(file.secret_key.trim_start_matches("ed25519:"))
        .into_vec()
        .unwrap_or_else(|_| die("bad secret key"));
    let pair: [u8; 64] = bytes
        .try_into()
        .unwrap_or_else(|_| die("bad secret key length"));
    SigningKey::from_keypair_bytes(&pair)
        .unwrap_or_else(|_| die("secret and public halves do not match"))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &str) -> T {
    let raw = fs::read_to_string(path).unwrap_or_else(|_| die(&format!("cannot read {path}")));
    serde_json::from_str(&raw).unwrap_or_else(|e| die(&format!("{path}: {e}")))
}

fn sign(k: &SigningKey, d: &[u8; 32]) -> String {
    B64.encode(k.sign(d).to_bytes())
}

/// Show what is about to be signed and ask before signing.
fn confirm(summary: &str, yes: bool) {
    eprintln!("{summary}");
    if yes {
        return;
    }
    if !io::stdin().is_terminal() {
        die("not signing without confirmation; run in a terminal or pass --yes");
    }
    eprint!("Sign this? Type yes: ");
    let mut answer = String::new();
    let _ = io::stdin().lock().read_line(&mut answer);
    if answer.trim() != "yes" {
        die("not signed");
    }
}

fn invoice_summary(inv: &Invoice, note: &DeliveryNote, document: &str) -> String {
    let mut out = format!(
        "About to sign:\n  invoice   {} from {} for order {}\n  pay to    {} / {} / {}\n  total     {} (smallest units of {})\n",
        inv.invoice_number,
        inv.supplier_id,
        inv.order_id,
        inv.payee.chain,
        inv.payee.token,
        inv.payee.address,
        inv.total,
        inv.token
    );
    for l in &inv.lines {
        out += &format!("  line      {} x {} at {}\n", l.qty, l.sku, l.unit_price);
    }
    out += &format!(
        "  delivery  note {} for order {}",
        note.note_id, note.order_id
    );
    for l in &note.lines {
        out += &format!("\n  delivered {} x {}", l.qty, l.sku);
    }
    out + &format!("\n  document  {document}")
}

fn die(msg: &str) -> ! {
    eprintln!("error: {msg}");
    process::exit(1)
}

// ------------------------------------------------------------------ commands

fn main() {
    let mut a: Vec<String> = env::args().skip(1).collect();
    let yes = a.first().is_some_and(|x| x == "--yes");
    if yes {
        a.remove(0);
    }
    let s: Vec<&str> = a.iter().map(String::as_str).collect();
    match s.as_slice() {
        ["keygen", name] => keygen(name),
        ["pubkey", name] => println!("{}", near_public(&load(name))),
        ["hash", file] => {
            let bytes = fs::read(file).unwrap_or_else(|_| die(&format!("cannot read {file}")));
            println!("{}", B64.encode(Sha256::digest(bytes)));
        }
        ["payout-change", key, contract, supplier_id, nonce, route] => {
            let route: PayoutRoute = read_json(route);
            let nonce: u64 = nonce
                .parse()
                .unwrap_or_else(|_| die("nonce must be a number"));
            confirm(
                &format!(
                    "About to sign a payout change:\n  supplier  {supplier_id}\n  new route {} / {} / {}\n  nonce     {nonce}\n  contract  {contract}",
                    route.chain, route.token, route.address
                ),
                yes,
            );
            let d = digest(&PayoutChangeMessage {
                domain: PAYOUT_CHANGE_DOMAIN,
                contract,
                supplier_id,
                nonce,
                route: &route,
            });
            let args = serde_json::json!({
                "supplier_id": supplier_id, "route": route, "nonce": nonce.to_string(), "signature": sign(&load(key), &d)
            });
            println!("{args}");
        }
        [
            "submit-args",
            supplier_key,
            storekeeper_key,
            contract,
            invoice,
            delivery,
            document,
        ] => {
            let invoice: Invoice = read_json(invoice);
            let note: DeliveryNote = read_json(delivery);
            let doc =
                fs::read(document).unwrap_or_else(|_| die(&format!("cannot read {document}")));
            let document_hash: [u8; 32] = Sha256::digest(&doc).into();
            if supplier_key == storekeeper_key {
                die("supplier and storekeeper keys must differ");
            }
            let supplier = load(supplier_key);
            let storekeeper = load(storekeeper_key);
            if supplier.verifying_key() == storekeeper.verifying_key() {
                die("supplier and storekeeper keys must differ");
            }
            confirm(&invoice_summary(&invoice, &note, document), yes);
            let d1 = digest(&InvoiceMessage {
                domain: INVOICE_DOMAIN,
                contract,
                invoice: &invoice,
                document_hash,
            });
            let d2 = digest(&DeliveryMessage {
                domain: DELIVERY_DOMAIN,
                contract,
                note: &note,
            });
            let args = serde_json::json!({
                "invoice": invoice,
                "supplier_signature": sign(&supplier, &d1),
                "delivery": note,
                "storekeeper_key": near_public(&storekeeper),
                "delivery_signature": sign(&storekeeper, &d2),
                "document_hash": B64.encode(document_hash),
            });
            println!("{args}");
        }
        _ => {
            eprintln!(
                "{}",
                include_str!("main.rs")
                    .lines()
                    .take_while(|l| l.starts_with("//!"))
                    .map(|l| l.trim_start_matches("//!").trim_start())
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            process::exit(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
    fn route() -> PayoutRoute {
        PayoutRoute {
            chain: "near".into(),
            token: "usdc.testnet".into(),
            address: "qingmar.testnet".into(),
        }
    }

    /// Same fixed messages and expected digests as the contract's vector_tests.rs.
    #[test]
    fn golden_digests_match_the_contract() {
        let c = "cleartopay.testnet";
        let change = digest(&PayoutChangeMessage {
            domain: PAYOUT_CHANGE_DOMAIN,
            contract: c,
            supplier_id: "qingmar-steel",
            nonce: 1,
            route: &route(),
        });
        let invoice = Invoice {
            supplier_id: "qingmar-steel".into(),
            invoice_number: "INV-2208".into(),
            order_id: "PO-1184".into(),
            token: "usdc.testnet".into(),
            lines: vec![InvoiceLine {
                sku: "AH36-12mm".into(),
                qty: 10,
                unit_price: 780_000,
            }],
            total: 7_800_000,
            payee: route(),
        };
        let note = DeliveryNote {
            order_id: "PO-1184".into(),
            note_id: "DN-552".into(),
            lines: vec![DeliveredLine {
                sku: "AH36-12mm".into(),
                qty: 10,
            }],
        };
        assert_eq!(
            hex(&change),
            "452a97d4d4c45de5ce784e89f78fc3845c2cf310551c9397dba7fc66235d9c28"
        );
        assert_eq!(
            hex(&digest(&InvoiceMessage {
                domain: INVOICE_DOMAIN,
                contract: c,
                invoice: &invoice,
                document_hash: [7u8; 32],
            })),
            "c32c1956cb24e02607430a2de0fddc3ee69c97d5c055f7f8991561996784c64f"
        );
        assert_eq!(
            hex(&digest(&DeliveryMessage {
                domain: DELIVERY_DOMAIN,
                contract: c,
                note: &note
            })),
            "5eebe4e05ec41c06b6df02cbca5a350cc35ca0c1bb9880e4ca663ae337097c18"
        );
    }

    #[test]
    fn contract_style_json_round_trips() {
        let raw = r#"{"supplier_id":"qingmar-steel","invoice_number":"INV-1","order_id":"PO-1184","token":"usdc.testnet",
            "lines":[{"sku":"AH36-12mm","qty":"10","unit_price":"780000"}],"total":"7800000",
            "payee":{"chain":"near","token":"usdc.testnet","address":"qingmar.testnet"}}"#;
        let inv: Invoice = serde_json::from_str(raw).unwrap();
        assert_eq!(inv.total, 7_800_000);
        let back = serde_json::to_value(&inv).unwrap();
        assert_eq!(back["lines"][0]["qty"], "10");
        assert_eq!(back["total"], "7800000");
    }

    #[test]
    fn the_preview_shows_payee_total_and_lines() {
        let inv = Invoice {
            supplier_id: "qingmar-steel".into(),
            invoice_number: "INV-2210".into(),
            order_id: "PO-1184".into(),
            token: "usdc.testnet".into(),
            lines: vec![InvoiceLine {
                sku: "AH36-12mm".into(),
                qty: 10,
                unit_price: 780_000,
            }],
            total: 7_800_000,
            payee: PayoutRoute {
                chain: "near".into(),
                token: "usdc.testnet".into(),
                address: "attacker.testnet".into(),
            },
        };
        let note = DeliveryNote {
            order_id: "PO-1184".into(),
            note_id: "DN-1".into(),
            lines: vec![],
        };
        let p = invoice_summary(&inv, &note, "inv.pdf");
        for want in ["attacker.testnet", "7800000", "10 x AH36-12mm", "INV-2210"] {
            assert!(p.contains(want), "preview is missing {want}");
        }
    }

    #[test]
    fn key_names_cannot_escape_the_key_folder() {
        assert!(!valid_name("../../etc/passwd"));
        assert!(!valid_name("a/b"));
        assert!(valid_name("qingmar-supplier"));
    }

    #[test]
    fn near_secret_key_format_round_trips() {
        let k = SigningKey::from_bytes(&[3u8; 32]);
        let s = bs58::encode(k.to_keypair_bytes()).into_string();
        let pair: [u8; 64] = bs58::decode(s).into_vec().unwrap().try_into().unwrap();
        assert_eq!(
            SigningKey::from_keypair_bytes(&pair)
                .unwrap()
                .verifying_key(),
            k.verifying_key()
        );
    }
}
