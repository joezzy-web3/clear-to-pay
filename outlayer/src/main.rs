//! OutLayer entry point: JSON on stdin, JSON on stdout. All logic is in lib.rs; this file wires in
//! the enclave: HTTPS to NEAR AI Cloud (the key comes from the project's sealed author secret),
//! randomness for the attestation nonce, and the `readings` key derived inside the TEE.

#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

#[cfg(target_arch = "wasm32")]
mod host {
    wit_bindgen::generate!({ world: "signing-keys-host", path: "wit" });
    use outlayer::signing_keys::api as keys;

    const BASE: &str = "https://cloud-api.near.ai";
    const KEY_PATH: &str = "readings";

    pub struct Enclave {
        pub api_key: String,
    }

    impl ctp_outlayer_reader::Host for Enclave {
        fn nearai(&self, method: &str, path: &str, body: Option<&[u8]>) -> Result<Vec<u8>, String> {
            if self.api_key.is_empty() {
                return Err("the reader's NEAR AI key is not set for this project".into());
            }
            let url = format!("{BASE}{path}");
            let auth = format!("Bearer {}", self.api_key);
            let c = wasi_http_client::Client::new();
            let req = if method == "POST" { c.post(&url) } else { c.get(&url) };
            let req = req
                .header("Authorization", auth.as_str())
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .header("x-no-aliasing", "true"); // refuse to be silently served a different model
            let req = match body {
                Some(b) => req.body(b),
                None => req,
            };
            let r = req.send().map_err(|e| format!("{method} {}: {e}", path.split('?').next().unwrap_or("")))?;
            let status = r.status();
            let b = r.body().map_err(|e| format!("read body: {e}"))?;
            if status != 200 {
                return Err(format!("{method} {}: HTTP {status}", path.split('?').next().unwrap_or("")));
            }
            Ok(b)
        }
        fn random32(&self) -> [u8; 32] {
            let mut b = [0u8; 32];
            getrandom::fill(&mut b).expect("no randomness in the enclave");
            b
        }
        fn pause(&self, ms: u64) {
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
        fn sign(&self, msg: &[u8]) -> Result<Vec<u8>, String> {
            keys::sign(KEY_PATH, None, msg)
        }
        fn public_key(&self) -> Result<Vec<u8>, String> {
            keys::public_key(KEY_PATH, None)
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {
    use std::io::Read;
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    // The author secret: stored for this project only, decrypted inside the TEE, never in the input.
    let api_key = std::env::var("NEARAI_API_KEY").unwrap_or_default();
    print!("{}", ctp_outlayer_reader::run(&input, &host::Enclave { api_key }));
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("ctp-outlayer-reader runs inside OutLayer (wasm32-wasip2). Tests: cargo test");
}
