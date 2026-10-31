#!/usr/bin/env bash
# Clear to Pay: upgrade guard.cleartopay.testnet IN PLACE (code only, state kept).
# Only for releases that do not change the contract's stored layout.
# Refuses to deploy while any transfer or withdrawal is in flight, so no callback
# can arrive at code that does not expect it (third security review, CTP3-02).
# Run from the repository root in a normal terminal. It stops before every step.
set -euo pipefail

C=guard.cleartopay.testnet
BUYER=buyer.cleartopay.testnet
USDC=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
NET="network-config testnet"

step() { echo; echo "=== $1"; read -r -p "Enter to run, Ctrl+C to stop " _; }
view() { near contract call-function as-read-only "$C" "$1" json-args "$2" $NET now; }

step "1/5  Tests, then build the contract"
cargo test -q
(cd tools/ctp-sign && cargo test -q)
cargo near build non-reproducible-wasm
ls -l target/near/clear_to_pay.wasm

step "2/5  Before: funds and supplier (should be 40 USDC available; payable from Mon 23:29)"
view get_funds "{\"token\":\"$USDC\"}"
view get_supplier '{"supplier_id":"qingmar-steel"}'

step "2b/5 Nothing may be in flight"
FLIGHT=$(view get_in_flight "{\"token\":\"$USDC\"}")
echo "$FLIGHT"
if ! echo "$FLIGHT" | grep -Eq '"payouts": *0\b' || ! echo "$FLIGHT" | grep -Eq '"withdrawing": *"0"'; then
  echo "A transfer or withdrawal is in flight. Wait for it to finish, then run this again."
  exit 1
fi

step "3/5  Send 1 NEAR from the buyer to the contract (storage for the slightly bigger code, plus the 0.05 NEAR reserve)"
near tokens "$BUYER" send-near "$C" '1 NEAR' $NET sign-with-legacy-keychain send

step "4/5  Deploy the new code WITHOUT re-initialising (state is kept)"
near contract deploy "$C" use-file target/near/clear_to_pay.wasm without-init-call \
  $NET sign-with-legacy-keychain send

step "5/5  After: the same funds and supplier, plus the new in-flight view"
view get_funds "{\"token\":\"$USDC\"}"
view get_supplier '{"supplier_id":"qingmar-steel"}'
view get_in_flight "{\"token\":\"$USDC\"}"

echo
echo "Done. Record the deploy transaction ID and the three 'After' outputs in docs/testnet-proof.md."
