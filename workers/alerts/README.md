# Alerts worker (Cloudflare)

Watches `guard.cleartopay.testnet` and `judge.cleartopay.testnet` and sends Telegram alerts through
@CleartoPayAlertsBOT, so no PC has to stay on. It is `reader/ctp_reader/alerts.py` (same rules, same
words) with one addition: each alert has an audience.

| Who | Subscribes with | Hears |
|---|---|---|
| Buyer | "Get alerts" on Buyer setup (`<net>_b`) | everything |
| A supplier | the link the buyer sends them, or the Sign page (`<net>_s_<id>`) | its payout address (proposed, approved, effective, cancelled), its invoices (CLEARED, HELD, SEIZED) and payments |
| Delivery signers | the link the buyer sends them, or the Sign page (`<net>_g`) | a delivery signer added or removed |

Only public on-chain facts are sent; anyone may subscribe, as anyone may read the ledger. Every minute
one contract is read (so each is read every 2 minutes, well inside the 72-hour wait it guards), checked
against a second RPC server for the supplier address and the signer list, and compared with the last
state in KV. KV is written only when something changed.

## Deploy (once)

```bash
cd workers/alerts
npm ci && npm test
npx wrangler login                       # opens Cloudflare in the browser
npx wrangler kv namespace create STATE   # copy the id it prints into wrangler.toml (id = "...")
npx wrangler secret put TELEGRAM_BOT_TOKEN   # paste the bot token at the hidden prompt
npx wrangler deploy                      # prints https://ctp-alerts.<you>.workers.dev
```

Then open `https://ctp-alerts.<you>.workers.dev/register` once: it points the bot at the worker. The
webhook's secret is derived from the bot token, so there is nothing else to set. Once you have subscribed with the
button, stop `reader/tools/alerts.py`, or your old chat gets each alert twice.

## The signature relay (`/relay`)

The same worker carries signatures from phones to the buyer's Inbox, so nobody copies links by hand. After a
delivery signer or the supplier taps Sign, their page posts the send-back link (`n=…&s=…&k=…` or `i=…`) to
`/relay?net=live|demo`; the buyer's Inbox reads `/relay?net=…` every 15 seconds and checks every item against the
chain before keeping it. Only that link shape is accepted (12 KB at most), each is kept once, for 30 days.
Nothing in it is secret: it is the signature the contract will check anyway. The Console finds the worker
through `RELAY` in `docs/console/chain.js`; until it is set, signatures travel by link and QR code only.

Commands in the bot: `/status` (your alerts), `/stop` (end them).
