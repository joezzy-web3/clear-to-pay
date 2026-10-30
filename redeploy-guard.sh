#!/usr/bin/env bash
# Clear to Pay: redeploy after patch 7 to a fresh contract, guard.cleartopay.testnet.
# Run from ~/clear-to-pay in a normal terminal (do not pipe it). It stops before
# every step; press Enter to run it, or Ctrl+C to stop. Safe to re-run a step.
# No key is printed or pasted anywhere: near-cli and ctp-sign read them from disk.
set -euo pipefail

OLD=cleartopay.testnet
NEW=guard.cleartopay.testnet
BUYER=buyer.cleartopay.testnet
USDC=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
NET="network-config testnet"

# Start from a later step: FROM=5 ./redeploy-guard.sh
FROM="${FROM:-1}"
N=0
step() {
  N=$((N + 1))
  if [ "$N" -lt "$FROM" ]; then SKIP=1; echo "--- skipping $1"; return; fi
  SKIP=0; echo; echo "=== $1"; read -r -p "Enter to run, Ctrl+C to stop " _
}
sign() { cargo run -q --manifest-path tools/ctp-sign/Cargo.toml -- "$@"; }
# call <contract> <method> <json> <deposit>
call() {
  near contract call-function as-transaction "$1" "$2" json-args "$3" \
    prepaid-gas '100.0 Tgas' attached-deposit "$4" \
    sign-as "$BUYER" $NET sign-with-legacy-keychain send
}
view() { near contract call-function as-read-only "$1" "$2" json-args "$3" $NET now; }
json() { python3 -c "import json,sys; print(json.dumps(eval(sys.argv[1])))" "$1"; }

step "1/11  Tests, then build the contract"
if [ "$SKIP" = 0 ]; then
cargo test -q
(cd tools/ctp-sign && cargo test -q)
cargo near build non-reproducible-wasm
ls -l target/near/*.wasm

fi
step "2/11  Old contract: how much USDC does it hold?"
if [ "$SKIP" = 0 ]; then
view "$OLD" get_funds "{\"token\":\"$USDC\"}"

fi
step "3/11  Withdraw the 15 test USDC from the old contract back to the buyer"
if [ "$SKIP" = 0 ]; then
call "$OLD" withdraw "{\"token\":\"$USDC\",\"amount\":\"15000000\"}" '1 yoctoNEAR'

fi
step "4/11  Check cleartopay.testnet has at least 4.2 NEAR free for the new account"
if [ "$SKIP" = 0 ]; then
near account view-account-summary "$OLD" $NET now

fi
step "5/11  Create $NEW with 4 NEAR (pays storage for the ~300 KB contract)"
if [ "$SKIP" = 0 ]; then
near account create-account fund-myself "$NEW" '3.4 NEAR' \
  autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain sign-as "$OLD" $NET sign-with-legacy-keychain send

fi
step "6/11  Deploy the patched contract and set the buyer as owner"
if [ "$SKIP" = 0 ]; then
near contract deploy "$NEW" use-file target/near/clear_to_pay.wasm \
  with-init-call new json-args "{\"owner\":\"$BUYER\"}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' $NET sign-with-legacy-keychain send

fi
step "7/11  Register the new contract with the USDC token (storage deposit)"
if [ "$SKIP" = 0 ]; then
call "$USDC" storage_deposit "{\"account_id\":\"$NEW\",\"registration_only\":true}" '0.00125 NEAR'

fi
step "8/11  Allow USDC, register Qingmar Steel, add the storekeeper (the 72-hour clock starts here)"
if [ "$SKIP" = 0 ]; then
call "$NEW" allow_token "{\"token\":\"$USDC\"}" '1 yoctoNEAR'
SUPPLIER_KEY=$(sign pubkey qingmar-supplier)
STORE_KEY=$(sign pubkey lagos-storekeeper)
call "$NEW" register_supplier "$(json "{'supplier_id':'qingmar-steel','signing_key':'$SUPPLIER_KEY','route':json.load(open('demo/route-qingmar.json'))}")" '1 yoctoNEAR'
call "$NEW" add_storekeeper "{\"key\":\"$STORE_KEY\"}" '1 yoctoNEAR'

fi
step "9/11  Purchase order PO-1184 and limits (10 USDC per invoice, 30 per 30 days, 100 submissions a day)"
if [ "$SKIP" = 0 ]; then
call "$NEW" create_order "$(json "{'order_id':'PO-1184','supplier_id':'qingmar-steel','token':'$USDC','lines':json.load(open('demo/order-lines.json'))}")" '1 yoctoNEAR'
call "$NEW" set_limits '{"per_invoice":"10000000","per_supplier_per_period":"30000000","period_hours":"720","max_submissions_per_day":100}' '1 yoctoNEAR'

fi
step "10/11  New agent key: may call only submit_invoice and execute_payment on $NEW, 0.25 NEAR gas"
if [ "$SKIP" = 0 ]; then
near account add-key "$BUYER" grant-function-call-access \
  --allowance '0.25 NEAR' --contract-account-id "$NEW" \
  --function-names 'submit_invoice, execute_payment' \
  autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain $NET sign-with-legacy-keychain send

fi
step "11/11  Deposit the 15 test USDC into the new contract"
if [ "$SKIP" = 0 ]; then
call "$USDC" ft_transfer_call "{\"receiver_id\":\"$NEW\",\"amount\":\"15000000\",\"msg\":\"\"}" '1 yoctoNEAR'
view "$NEW" get_funds "{\"token\":\"$USDC\"}"
view "$NEW" get_supplier '{"supplier_id":"qingmar-steel"}' || true

fi
echo
echo "Done. Send Claude the transaction links (nearblocks) from the output, not any keys."
