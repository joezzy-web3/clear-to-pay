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

    const HOST: &str = "cloud-api.near.ai";
    const KEY_PATH: &str = "readings";

    pub struct Enclave {
        pub api_key: String,
    }

    impl ctp_outlayer_reader::Host for Enclave {
        fn nearai(&self, method: &str, path: &str, body: Option<&[u8]>) -> Result<Vec<u8>, String> {
            if self.api_key.is_empty() {
                return Err("the reader's NEAR AI key is not set for this project".into());
            }
            let short = path.split('?').next().unwrap_or("").to_string();
            let mut path = path.to_string();
            for _ in 0..4 {
                let (status, location, b) = super::http::send(method, HOST, &path, &self.api_key, body).map_err(|e| format!("{method} {short}: {e}"))?;
                if matches!(status, 301 | 302 | 307 | 308) {
                    // follow a redirect on the same host only (the network allowlist names one host)
                    let loc = location.unwrap_or_default();
                    let rel = loc.strip_prefix(&format!("https://{HOST}")).unwrap_or(&loc).to_string();
                    if !rel.starts_with('/') {
                        return Err(format!("{method} {short}: redirected off {HOST}"));
                    }
                    path = rel;
                    continue;
                }
                if status != 200 {
                    // NEAR AI's own error text (never contains our key), cut short
                    let why = String::from_utf8_lossy(&b[..b.len().min(200)]).replace(['\n', '\r'], " ");
                    return Err(format!("{method} {short}: HTTP {status} {why}"));
                }
                return Ok(b);
            }
            Err(format!("{method} {short}: too many redirects"))
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

/// A small HTTPS client on wasi:http. Bodies are written in pieces of at most 4096 bytes (one
/// blocking write may not take more), so a long invoice goes out whole.
#[cfg(target_arch = "wasm32")]
mod http {
    use wasi::http::outgoing_handler;
    use wasi::http::types::{Fields, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme};
    use wasi::io::streams::StreamError;

    pub fn send(method: &str, host: &str, path: &str, key: &str, body: Option<&[u8]>) -> Result<(u16, Option<String>, Vec<u8>), String> {
        let h = Fields::new();
        for (k, v) in [("authorization", format!("Bearer {key}")), ("content-type", "application/json".into()), ("accept", "application/json".into()), ("x-no-aliasing", "true".into())] {
            h.append(&k.to_string(), &v.into_bytes()).map_err(|e| format!("header {k}: {e:?}"))?;
        }
        let req = OutgoingRequest::new(h);
        req.set_method(if method == "POST" { &Method::Post } else { &Method::Get }).map_err(|_| "method")?;
        req.set_scheme(Some(&Scheme::Https)).map_err(|_| "scheme")?;
        req.set_authority(Some(host)).map_err(|_| "authority")?;
        req.set_path_with_query(Some(path)).map_err(|_| "path")?;
        let ob = req.body().map_err(|_| "request body")?;
        if let Some(b) = body {
            let w = ob.write().map_err(|_| "request stream")?;
            for piece in b.chunks(4096) {
                w.blocking_write_and_flush(piece).map_err(|e| format!("write: {e:?}"))?;
            }
            drop(w);
        }
        OutgoingBody::finish(ob, None).map_err(|e| format!("finish: {e:?}"))?;
        let opts = RequestOptions::new();
        let _ = opts.set_connect_timeout(Some(30_000_000_000));
        let _ = opts.set_first_byte_timeout(Some(110_000_000_000));
        let fut = outgoing_handler::handle(req, Some(opts)).map_err(|e| format!("send: {e:?}"))?;
        let resp = match fut.get() {
            Some(r) => r,
            None => {
                fut.subscribe().block();
                fut.get().ok_or("no response")?
            }
        }
        .map_err(|_| "response already taken")?
        .map_err(|e| format!("{e:?}"))?;
        let status = resp.status();
        let location = resp.headers().get(&"location".to_string()).into_iter().next().and_then(|v| String::from_utf8(v).ok());
        let ib = resp.consume().map_err(|_| "response body")?;
        let mut out = Vec::new();
        {
            let s = ib.stream().map_err(|_| "response stream")?;
            loop {
                match s.blocking_read(1 << 20) {
                    Ok(mut c) => out.append(&mut c),
                    Err(StreamError::Closed) => break,
                    Err(e) => return Err(format!("read: {e:?}")),
                }
            }
        }
        drop(ib);
        Ok((status, location, out))
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
