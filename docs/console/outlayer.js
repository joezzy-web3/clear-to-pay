// Clear to Pay Judge mode: "Your own invoice" (experimental). The PDF is read in this browser
// (pdf.js), every line is checked for ink on the rendered page, and only the text a person can
// see goes to the reader running inside OutLayer's TEE. The reading comes back signed; this page
// checks it (outlayer-verify.js) and shows who the contract would pay. The AI decides nothing.
import * as C from "./crypto.js";
import { view, esc } from "./chain.js";
import { READER, PAYMENT_WORDS, checkReading, checkAttestation } from "./outlayer-verify.js";

const PDFJS = new URL("./vendor/pdfjs-4.10.38/", import.meta.url).href; // pdfjs-dist 4.10.38 from npm, kept here byte for byte (SHA256SUMS)
const CONTRACT = "judge.cleartopay.testnet";
const MAX_BYTES = 2_000_000, MAX_PAGES = 5, MAX_TEXT = 40_000;
const $ = (id) => document.getElementById(id);

let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import(PDFJS + "pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs";
  }
  return pdfjs;
}

/** Text a person can see, and text they cannot. A line is hidden when its box on the rendered
 *  page has (almost) no ink: white on white, invisible render mode, a microscopic font, covered
 *  by a shape drawn on top, or outside the page. This checks the picture, not the colour codes. */
export async function readPdf(bytes) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: false }).promise;
  if (doc.numPages > MAX_PAGES) throw new Error(`Up to ${MAX_PAGES} pages, please (this one has ${doc.numPages}).`);
  const lines = [], hidden = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p), vp = page.getViewport({ scale: 2 });
    const cv = document.createElement("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const tc = await page.getTextContent();
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      const size = Math.hypot(it.transform[2], it.transform[3]);
      const w = Math.max(1, it.width * vp.scale), h = Math.max(1, size * vp.scale);
      const why = size < 1 ? "tiny_font" : inkWhy(g, cv, x, y - h, w, h);
      if (why) { hidden.push({ text: it.str.trim(), why }); continue; }
      const key = Math.round(it.transform[5]);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push({ x: it.transform[4], s: it.str });
    }
    [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, r]) => lines.push(r.sort((a, b) => a.x - b.x).map((i) => i.s).join(" ").replace(/\s+/g, " ").trim()));
  }
  const text = lines.filter(Boolean).join("\n");
  const held = hidden.some((h) => PAYMENT_WORDS.test(h.text));
  return { text, hidden, held };
}

function inkWhy(g, cv, x, y, w, h) {
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(cv.width, Math.ceil(x + w)), y1 = Math.min(cv.height, Math.ceil(y + h));
  if (x1 - x0 < 1 || y1 - y0 < 1 || (x1 - x0) * (y1 - y0) < 0.25 * w * h) return "outside_page";
  const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  // the box's most common colour is its background; ink is anything clearly different from it
  const count = new Map();
  for (let i = 0; i < d.length; i += 4) { const k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | d[i + 2] >> 4; count.set(k, (count.get(k) || 0) + 1); }
  const bg = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const br = ((bg >> 8) & 15) * 16 + 8, bgg = ((bg >> 4) & 15) * 16 + 8, bb = (bg & 15) * 16 + 8;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.max(Math.abs(d[i] - br), Math.abs(d[i + 1] - bgg), Math.abs(d[i + 2] - bb)) > 64) ink++;
  return ink / (d.length / 4) < 0.004 ? "no_visible_ink" : null;
}

async function callReader(text, sha) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 150_000);
  try {
    const r = await fetch(`${READER.api}/call/${READER.project}`, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "X-Payment-Key": READER.paymentKey },
      body: JSON.stringify({ input: { document_text: text, document_sha256: sha }, resource_limits: { max_execution_seconds: 120 } }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.status !== "completed" || !j.output) throw new Error((j && (j.error || j.message)) || `OutLayer answered ${r.status}`);
    if (j.output.error) throw new Error("The reader: " + j.output.error);
    return j;
  } finally { clearTimeout(t); }
}

// ---- the card

const STEPS = ["Read the PDF in this browser", "Check every line for ink", "Send the visible text to the reader in OutLayer's TEE", "Check what came back"];
function steps(state) {
  $("own-steps").innerHTML = STEPS.map((s, i) => `<li class="${state[i] || "wait"}"><i>${state[i] === "ok" ? "✓" : state[i] === "no" ? "✕" : state[i] === "run" ? "…" : "·"}</i><span>${s}</span></li>`).join("");
}
const checkList = (cs) => cs.map((c) => `<li class="${c.ok ? "ok" : "no"}"><i>${c.ok ? "✓" : "✕"}</i><span>${esc(c.label)}<small>${esc(c.detail)}</small></span></li>`).join("");
const fail = (msg) => { $("own-out").innerHTML = `<p class="own-calm">${esc(msg)} The two signed invoices above always work: they were read the same way and show the contract deciding.</p>`; };

async function run(file) {
  const out = $("own-out"); out.innerHTML = ""; $("own-go").disabled = true;
  const st = [];
  try {
    if (!file) return;
    if (file.size > MAX_BYTES || !/pdf$/i.test(file.type || file.name)) throw new Error("A PDF up to 2 MB, please.");
    st[0] = "run"; steps(st);
    const bytes = new Uint8Array(await file.arrayBuffer()), sha = C.sha256Hex(bytes);
    const pdf = await readPdf(bytes);
    st[0] = "ok"; st[1] = pdf.held ? "no" : "ok"; steps(st);
    const hid = pdf.hidden.length ? `<div class="own-hidden"><b>${pdf.held ? "Held: hidden text about payment" : "Hidden text dropped"}</b>${pdf.hidden.slice(0, 6).map((h) => `<q>${esc(h.text)}</q><small>${esc(h.why)}</small>`).join("")}</div>` : "";
    if (pdf.held) {
      out.innerHTML = hid + `<p class="own-calm">This invoice is <b>held</b> (<code>hidden_text</code>), the same rule as the CLI reader: text no person can see talks about payment, so no AI reads it. A person looks at it first.</p>`;
      return;
    }
    if (!pdf.text.trim()) throw new Error("No text in this PDF (a scan?). This demo reads text PDFs only.");
    if (pdf.text.length > MAX_TEXT) throw new Error("That is a lot of text for one invoice.");
    st[2] = "run"; steps(st);
    const res = await callReader(pdf.text, sha);
    st[2] = "ok"; st[3] = "run"; steps(st);
    const { reading: r, checks } = checkReading(res.output, sha);
    let att = null;
    try { att = await (await fetch(READER.api + res.attestation_url, { cache: "no-store" })).json(); } catch {}
    const aChecks = att ? checkAttestation(att, res.output) : [{ ok: false, label: "OutLayer's attestation", detail: "could not be fetched; try the link below" }];
    const all = checks.concat(aChecks), ok = all.every((c) => c.ok);
    st[3] = ok ? "ok" : "no"; steps(st);
    out.innerHTML = hid + await result(r, all, ok, res, sha);
  } catch (e) {
    st[st.findIndex((x) => x === "run")] = "no"; steps(st);
    fail(e.name === "AbortError" ? "The reader took too long." : e.message || String(e));
  } finally { $("own-go").disabled = false; }
}

async function result(r, checks, ok, res, sha) {
  const e = r && r.extraction;
  let payee = "";
  if (e) {
    let reg = null; try { reg = await view(CONTRACT, "get_supplier", { supplier_id: e.supplier_id }); } catch {}
    payee = reg ? `<b>${esc(reg.route_on_file?.address || "the registered address")}</b><small>the address registered on chain for <code>${esc(e.supplier_id)}</code>, never one from the invoice</small>`
      : `<b>nobody</b>: <code>${esc(e.supplier_id)}</code> is not a registered supplier on this contract`;
  }
  const lines = e ? e.lines.map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.qty)}</td><td>${esc(l.unit_price)}</td></tr>`).join("") : "";
  const att = READER.api + res.attestation_url;
  return `<div class="own-res">
    <div><h4>${ok ? "Signed, and every check passes" : "Something did not check out"}</h4><ul class="checks">${checkList(checks)}</ul></div>
    <div>${e ? `<h4>What the AI read</h4><dl class="own-kv"><dt>Supplier</dt><dd>${esc(e.supplier_id)}</dd><dt>Invoice</dt><dd>${esc(e.invoice_number)}</dd><dt>Order</dt><dd>${esc(e.order_id)}</dd><dt>Total</dt><dd>${esc(e.total)} ${esc(e.currency)}</dd></dl>
      <table class="own-lines"><tr><th>SKU</th><th>Qty</th><th>Unit price</th></tr>${lines}</table>
      ${r.held.length ? `<p class="own-calm">Held: <code>${esc(r.held.join(", "))}</code></p>` : ""}
      <div class="own-payee"><span>There is no payee in this reading. The contract would pay</span>${payee}</div>`
      : `<h4>No extraction</h4><p class="own-calm">${esc((r && (r.rejected || r.held.join(", "))) || "The reading was not usable.")} Nothing would be paid.</p>`}</div>
  </div>
  <p class="note">The AI ran inside a sealed machine. This signature proves which code read your invoice. Enclave key <code>${READER.enclaveKey.slice(0, 16)}…</code> · WASM <a href="${READER.release}" target="_blank" rel="noopener"><code>${READER.wasm.slice(0, 16)}…</code></a> · <a href="${esc(att)}" target="_blank" rel="noopener">OutLayer attestation</a> · file sha-256 <code>${sha.slice(0, 16)}…</code></p>`;
}

export function init() {
  const f = $("own-file"), go = $("own-go");
  if (!f || !go) return;
  steps([]);
  const idle = $("own-out").innerHTML, x = $("own-clear");
  const clear = () => { f.value = ""; go.disabled = true; x.hidden = true; $("own-name").textContent = "No file chosen"; $("own-out").innerHTML = idle; steps([]); };
  f.addEventListener("change", () => {
    go.disabled = !f.files.length; x.hidden = !f.files.length;
    $("own-name").textContent = f.files[0]?.name || "No file chosen";
    $("own-out").innerHTML = idle; steps([]); // a new file starts clean
  });
  x.addEventListener("click", () => { clear(); f.focus(); });
  go.addEventListener("click", () => run(f.files[0]));
}
init();
