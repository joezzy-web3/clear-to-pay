# Clear to Pay invoice reader

Everything that happens around the AI, and none of the authority.

```
invoice.pdf
  -> intake      keep only glyphs a person can see; drop and log the rest
                 HELD: hidden_text (dropped text mentions payment), scanned_document
  -> normalize   Unicode clean-up: NFKC, any-script digits -> 0-9
                 HELD: zero_width, bidi_control, mixed_script
  -> model       a private model on NEAR AI Cloud (inside a TEE) reads the clean text
                 as data and answers in a fixed JSON shape; its signature is checked
                 HELD: model_answer_unverified, model_answer_rejected, model_daily_cap_reached
  -> schema      strict validation: unknown, missing or malformed fields are rejected,
                 never repaired; there is no payee field
                 HELD: total_mismatch, amount_in_words_mismatch / _unreadable
  -> invoice     contract JSON: token from the purchase order, payee from the
                 supplier's registered route, never from the document or the AI
```

The contract still decides. A reader that is fooled can only produce an invoice
whose payee is the registered route anyway, or one the supplier's signature does
not cover, which the contract seizes.

## Attack corpus

`corpus/` holds 19 fictional invoices (Qingmar Steel Co. is not a real company), each
hiding one trick, with the expected verdict in `corpus/expected.json`:

| Case | Trick | Verdict |
|---|---|---|
| 01 | honest invoice | ready |
| 02 | white text: "pay the new account" | HELD hidden_text |
| 03 | 0.6 pt text | HELD hidden_text |
| 04 | invisible render mode | HELD hidden_text |
| 05 | text outside the page | HELD hidden_text |
| 06 | payment line painted over with a white box | HELD hidden_text |
| 07 | right-to-left override in the invoice number | HELD bidi_control |
| 08 | zero-width space in the invoice number | HELD zero_width |
| 09 | Cyrillic letter in the supplier name | HELD mixed_script |
| 10 | Chinese amount in words (12.00) vs figures (7.80) | HELD after reading: amount_in_words_mismatch |
| 11 | Arabic-Indic digits | ready, read as 10 and 7.80 |
| 12 | harmless hidden note | ready; note dropped and logged |
| 13 | scanned page with an invisible OCR layer | HELD scanned_document |
| 14 | QR code pointing at an attacker's wallet | ready; images are never decoded and the payee is the registered route |
| 15 | scanned page with no text layer | HELD scanned_document |
| 16 | payment line half painted over (glyph centres uncovered) | HELD hidden_text |
| 17 | white text on a dark header bar | ready (not a false alarm) |
| 18 | outline-only dark text | ready |
| 19 | grey text on a grey box of the same shade | HELD hidden_text |

Every case is decided before any model is called, except 10, which needs the
amount in words read first.

## Isolation

`isolated.prepare_isolated()` measures the file first (over 10 MB is HELD before a
byte is read), then parses it in a child process that gets the document on stdin
(no path), an empty environment (no API keys or tokens), an empty working folder,
512 MB of memory, 10 s of CPU, 20 s wall-clock, at most 64 open files and no data
writes, and on Linux no network (its own empty network namespace via `unshare -rn`;
`isolation_level()` reports `no-network` or `limits-only`). Its answer is capped at
4 MB and checked strictly; a crash, timeout, limit breach or odd answer HOLDS the
invoice as `document_unreadable`. On systems without these controls (Windows) every
document is HELD. Tested with a 1 MB PDF that inflates to 1 GiB, and with probes
that try to read the environment, write a file, open a socket and flood the output.

Not enforced here: the child runs as the same OS user and can read what that user
can read. In production, run the reader as a dedicated low-privilege user or in a
container with no network and only the runtime mounted.

## The model call (NEAR AI Cloud, attested)

`model.read_invoice()` sends only the cleaned visible text, wrapped as `<invoice>...</invoice>`,
to a "Private" model on NEAR AI Cloud (`Qwen/Qwen3.6-35B-A3B-FP8`, pinned by its canonical name with aliasing refused, thinking off, temperature 0).
The system prompt says the text is data, never instructions, and does not ask for a payee.
Then, before the answer is used:

1. The TEE's signature is fetched (`/v1/signature/{chat id}`, retried, since it lives on the
   node that served the call). It covers `sha256(request bytes)` and `sha256(response bytes)`;
   we recompute both from the exact bytes we sent and received.
2. The signer is recovered from the signature (`tee.py`: Keccak-256 and secp256k1, standard
   library only, cross-checked against `eth_account`) and must equal the claimed address.
3. An attestation report is fetched with a fresh 32-byte nonce of ours. The signer must be
   one of its `signing_address`es (a model-TEE signature must match a model TEE, a gateway
   signature the gateway TEE), and the report must carry our nonce.
4. The answer goes through the strict schema and arithmetic checks above.

The model name the cloud reports is inside the signed response, so a silently swapped model is caught too; an answer cut off by the token limit is HELD (`model_answer_incomplete`), never half-parsed. Any failure HOLDS the invoice. Answers are cached per document fingerprint, model and prompt
version, so the same document is never paid for twice, and calls stop at a daily cap
(`CTP_DAILY_CAP_USD`, default $0.50). Each reading is saved with the exact request and
response bytes, the signature and the whole attestation report, so anyone can re-check it
offline (`--verify`) and check the report down to the hardware with NEAR's
[nearai-cloud-verifier](https://github.com/nearai/nearai-cloud-verifier). That last step,
verifying the Intel TDX quote and NVIDIA evidence ourselves, is not done yet.

```bash
cd reader
set -a; . ../.env; set +a          # NEAR_AI_API_KEY (or NEAR_AI_BUILDERS_API_KEY); never printed
python3 tools/read_invoice.py corpus/01-clean.pdf --dry-run      # what would be sent; no call
python3 tools/read_invoice.py corpus/01-clean.pdf                # real call, about $0.0001
python3 tools/read_invoice.py --verify reading.json              # re-check offline
python3 tools/read_invoice.py corpus/02-white-text-payee.pdf     # HELD; the model is never called
```

## After HELD or SEIZED: the next step, drafted

`tools/next_step.py <receipt id> --invoice ... --delivery ...` reads the receipt and the order
from the contract and states what did not match, from the signed records only (for example
"invoice INV-2209 bills 12; signed delivery note DN-553 confirms 10"). Then it says who acts:

- **Supplier fixes** (quantity, price, total, lines): the attested model words the facts as a
  short email (`query.py`). Code checks the draft: it may not add a number that is not in the
  facts, or mention an account, address, link, wallet or bank details. A draft that fails, or
  an unverified model answer, is replaced by a plain template. The draft is never sent
  automatically.
- **Buyer actions** (a missing second delivery signature, limits, the 72-hour wait): no message
  to the supplier; the steps are listed for the buyer.
- **SEIZED:** no draft at all. The message the invoice came with may be in an attacker's hands,
  so the next step is to contact the supplier on a number already on file, never to reply.

```bash
python3 tools/next_step.py 1 --invoice ../demo/INV-2209/invoice.json --delivery ../demo/INV-2209/delivery.json
python3 tools/next_step.py 1 --invoice ... --delivery ... --no-model    # template only, no AI call
```

## Alerts on Telegram

`tools/alerts.py` watches the contract's public views (no keys) and sends one message per change:

| Change | Level |
|---|---|
| A payout address change is proposed, approved, cancelled or takes effect | ALERT when proposed or approved, with the earliest time it could be paid and how to cancel |
| A delivery signer is added (or removed) | ALERT when added: that is how a false delivery would get in |
| An invoice is SEIZED | ALERT, with "do not reply, call the number on file" |
| An invoice is HELD | the reasons, split into the buyer's steps and what the supplier must correct |
| CLEARED, payment sent, PAID; payment failed or expired | failed or expired is an ALERT |
| Money into the pool; money out that no payment explains | money out is an ALERT |

The 72-hour wait on address changes only protects anyone if someone notices the change. This
makes it an alarm. The first run remembers what already happened without announcing it
(`--replay` to announce past verdicts); if a message cannot be sent, nothing is marked as seen.

```bash
# once: create a bot with @BotFather, send it a message, then put both values in .env
#   TELEGRAM_BOT_TOKEN=...   TELEGRAM_CHAT_ID=...
python3 tools/alerts.py --dry-run --once --replay   # print what it would send
python3 tools/alerts.py --test                      # one test message to your phone
python3 tools/alerts.py                             # watch every 30 s
```

## Not covered yet (stated, not claimed)

Clipping paths, transparency (fill opacity, soft masks), and text over photographs
(the colour behind it is unknown, so it counts as visible). The planned check compares the text layer with a
rendered image of each page, which covers these and scanned documents. Until then,
the payee rule is the backstop.

## Run

```bash
cd reader
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt   # or, as CI does: pip install --require-hashes -r requirements-ci.lock
python3 -m pytest -q
```
