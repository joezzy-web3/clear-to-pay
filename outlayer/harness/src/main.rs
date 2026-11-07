//! Runs the reader component the way an OutLayer worker starts one: wasmtime 28, stdin in,
//! stdout out, wasi:http linked, and a stand-in for outlayer:signing-keys (a fixed test key;
//! the real one is derived inside the TEE). Then checks the output's ed25519 signature.
//!
//!   harness <component.wasm> '<input json>' [NEARAI_API_KEY]

use anyhow::{bail, Context, Result};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier};
use sha2::{Digest, Sha256};
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::pipe::{MemoryInputPipe, MemoryOutputPipe};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiView};
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpView};

mod keys {
    wasmtime::component::bindgen!({ path: "../wit", world: "signing-keys-host" });
}

struct State {
    table: ResourceTable,
    wasi: WasiCtx,
    http: WasiHttpCtx,
    key: SigningKey,
}
impl WasiView for State {
    fn table(&mut self) -> &mut ResourceTable { &mut self.table }
    fn ctx(&mut self) -> &mut WasiCtx { &mut self.wasi }
}
impl WasiHttpView for State {
    fn ctx(&mut self) -> &mut WasiHttpCtx { &mut self.http }
    fn table(&mut self) -> &mut ResourceTable { &mut self.table }
}
impl keys::outlayer::signing_keys::api::Host for State {
    fn public_key(&mut self, path: String, vault: Option<String>) -> Result<Vec<u8>, String> {
        if path != "readings" || vault.is_some() { return Err(format!("undeclared key {path}")); }
        Ok(self.key.verifying_key().to_bytes().to_vec())
    }
    fn sign(&mut self, path: String, vault: Option<String>, message: Vec<u8>) -> Result<Vec<u8>, String> {
        self.public_key(path, vault)?;
        Ok(self.key.sign(&message).to_bytes().to_vec())
    }
    fn sign_nep413(&mut self, _: String, _: Option<String>, _: String, _: String, _: Vec<u8>, _: Option<String>)
        -> Result<keys::outlayer::signing_keys::api::Nep413Signature, String> {
        Err("not used by the reader".into())
    }
}

fn main() -> Result<()> {
    let mut a = std::env::args().skip(1);
    let wasm = a.next().context("usage: harness <component.wasm> '<input json>' [NEARAI_API_KEY]")?;
    let input = a.next().unwrap_or_else(|| r#"{"op":"public_key"}"#.into());
    let api_key = a.next().unwrap_or_default();

    let mut config = Config::new();
    config.wasm_component_model(true);
    let engine = Engine::new(&config)?;
    let component = Component::from_file(&engine, &wasm)?;
    let mut linker: Linker<State> = Linker::new(&engine);
    wasmtime_wasi::add_to_linker_sync(&mut linker)?;
    wasmtime_wasi_http::add_only_http_to_linker_sync(&mut linker)?;
    keys::SigningKeysHost::add_to_linker(&mut linker, |s: &mut State| s)?;

    let stdout = MemoryOutputPipe::new(10 << 20);
    let mut b = WasiCtxBuilder::new();
    b.stdin(MemoryInputPipe::new(input.into_bytes())).stdout(stdout.clone()).inherit_stderr();
    if !api_key.is_empty() { b.env("NEARAI_API_KEY", &api_key); }
    let state = State { table: ResourceTable::new(), wasi: b.build(), http: WasiHttpCtx::new(), key: SigningKey::from_bytes(&[7u8; 32]) };
    let mut store = Store::new(&engine, state);
    let cmd = wasmtime_wasi::bindings::sync::Command::instantiate(&mut store, &component, &linker)?;
    let _ = cmd.wasi_cli_run().call_run(&mut store)?;
    let out = String::from_utf8(stdout.contents().to_vec())?;
    println!("{out}");

    let v: serde_json::Value = serde_json::from_str(&out).context("output is not JSON")?;
    if let Some(reading) = v.get("reading").and_then(|r| r.as_str()) {
        let msg = format!("clear-to-pay/reading/v1:{}", hex::encode(Sha256::digest(reading.as_bytes())));
        if v["signed_message"] != msg.as_str() { bail!("signed_message is not the reading's digest"); }
        let sig = Signature::from_slice(&hex::decode(v["signature"].as_str().unwrap_or(""))?)?;
        let pk = ed25519_dalek::VerifyingKey::from_bytes(&hex::decode(v["public_key"].as_str().unwrap_or(""))?.try_into().map_err(|_| anyhow::anyhow!("bad key"))?)?;
        pk.verify(msg.as_bytes(), &sig).context("enclave signature does not verify")?;
        eprintln!("[harness] signature over the reading verifies");
    }
    Ok(())
}
