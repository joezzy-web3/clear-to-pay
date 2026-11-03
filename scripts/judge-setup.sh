#!/usr/bin/env bash
# Clear to Pay: set up the Judge mode demo contract (one time).
#
# Judge mode (docs/console/) lets anyone send real testnet transactions from the
# browser. It never touches guard.cleartopay.testnet. It uses its own pair:
#   judge.cleartopay.testnet        a copy of the same contract (same wasm)
#   judge-buyer.cleartopay.testnet  its owner; the only account that may submit
# and ONE function-call key on judge-buyer, fenced on chain to judge.cleartopay.testnet,
# methods submit_invoice and execute_payment only, with a NEAR gas allowance. That key
# is PUBLIC on purpose (docs/console/agent.json): the page has no server to hide it in.
# The worst anyone can do with it is spend its gas allowance or fill the daily
# submission cap. It cannot move money anywhere but the registered payout address,
# because the contract decides, not the key.
#
# Run from the repository root in a normal terminal. It stops before every step.
# After step 4 the supplier's 72-hour wait starts: honest runs CLEAR only after it.
set -euo pipefail

PARENT=${PARENT:-cleartopay.testnet}
J=judge.cleartopay.testnet
JB=judge-buyer.cleartopay.testnet
BUYER=buyer.cleartopay.testnet
USDC=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
POOL_USDC=${POOL_USDC:-15}          # USDC moved into the demo pool (0.78 per honest run)
ALLOWANCE=${ALLOWANCE:-5 NEAR}      # gas allowance of the public demo key
NET="network-config testnet"
CTP="cargo run -q --manifest-path tools/ctp-sign/Cargo.toml --"
SIGN="$NET sign-with-legacy-keychain send"

step() { echo; echo "=== $1"; read -r -p "Enter to run, Ctrl+C to stop " _; }
call() { # account method json deposit
  near contract call-function as-transaction "$J" "$1" json-args "$2" \
    prepaid-gas '50.0 Tgas' attached-deposit "${3:-1 yoctoNEAR}" sign-as "$JB" $SIGN
}
view() { near contract call-function as-read-only "$J" "$1" json-args "$2" $NET now; }
units() { python3 -c "import sys;print(int(round(float(sys.argv[1])*1_000_000)))" "$1"; }

step "1/9  Build the contract (the same code as guard v2.3)"
cargo near build non-reproducible-wasm
ls -l target/near/clear_to_pay.wasm

step "2/9  Create $JB (2 NEAR) and $J (5 NEAR), signed by $PARENT"
near account create-account fund-myself "$JB" '2 NEAR' autogenerate-new-keypair save-to-legacy-keychain \
  sign-as "$PARENT" $SIGN
near account create-account fund-myself "$J" '5 NEAR' autogenerate-new-keypair save-to-legacy-keychain \
  sign-as "$PARENT" $SIGN

step "3/9  Deploy and initialise: owner = $JB"
near contract deploy "$J" use-file target/near/clear_to_pay.wasm with-init-call new \
  json-args "{\"owner\":\"$JB\"}" prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' $SIGN

step "4/9  Register qingmar-steel with its registered route (the 72-hour wait starts now)"
SUP=$($CTP pubkey qingmar-supplier)
ROUTE=$(python3 -c "import json;print(json.dumps(json.load(open('demo/route-qingmar.json'))))")
call register_supplier "{\"supplier_id\":\"qingmar-steel\",\"signing_key\":\"$SUP\",\"route\":$ROUTE}"
view get_supplier '{"supplier_id":"qingmar-steel"}'

step "5/9  Delivery signers (storekeeper + weighbridge), the order PO-J1, limits, USDC"
call add_delivery_signer "{\"key\":\"$($CTP pubkey lagos-storekeeper)\",\"role\":\"storekeeper\"}"
call add_delivery_signer "{\"key\":\"$($CTP pubkey lagos-weighbridge)\",\"role\":\"weighbridge\"}"
call create_order "{\"order_id\":\"PO-J1\",\"supplier_id\":\"qingmar-steel\",\"token\":\"$USDC\",\"lines\":[{\"sku\":\"AH36-12mm\",\"qty\":\"1000\",\"unit_price\":\"780000\"}]}"
call set_limits '{"per_invoice":"7800000","per_supplier_per_period":"50000000","period_hours":"24","max_submissions_per_day":200}'
call allow_token "{\"token\":\"$USDC\"}"

step "6/9  USDC storage for $J and $JB (0.00125 NEAR each)"
for A in "$J" "$JB"; do
  near contract call-function as-transaction "$USDC" storage_deposit json-args "{\"account_id\":\"$A\"}" \
    prepaid-gas '30.0 Tgas' attached-deposit '0.00125 NEAR' sign-as "$JB" $SIGN
done

step "7/9  Fund the demo pool: $BUYER sends $POOL_USDC USDC to $JB, which deposits it into $J"
AMT=$(units "$POOL_USDC")
near contract call-function as-transaction "$USDC" ft_transfer json-args "{\"receiver_id\":\"$JB\",\"amount\":\"$AMT\"}" \
  prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$BUYER" $SIGN
near contract call-function as-transaction "$USDC" ft_transfer_call json-args "{\"receiver_id\":\"$J\",\"amount\":\"$AMT\",\"msg\":\"\"}" \
  prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$JB" $SIGN
view get_funds "{\"token\":\"$USDC\"}"

step "8/9  The public demo key: generate it, fence it to $J (submit_invoice, execute_payment; $ALLOWANCE)"
[ -f "$HOME/.config/clear-to-pay/keys/judge-agent.json" ] || $CTP keygen judge-agent
PK=$($CTP pubkey judge-agent)
near account add-key "$JB" grant-function-call-access --allowance "$ALLOWANCE" \
  --contract-account-id "$J" --function-names 'submit_invoice, execute_payment' \
  use-manually-provided-public-key "$PK" $SIGN
near account list-keys "$JB" $NET now

step "9/9  Publish the demo key into docs/console/agent.json and allow it in the secret scan"
python3 - "$JB" "$J" <<'PY'
import json, os, re, sys
jb, j = sys.argv[1], sys.argv[2]
k = json.load(open(os.path.expanduser("~/.config/clear-to-pay/keys/judge-agent.json")))
pk, sk = k["public_key"], k["secret_key"]
out = {"note": "PUBLIC demo key, published on purpose. Fenced on chain: receiver " + j +
       ", methods submit_invoice and execute_payment, gas allowance only. It cannot attach a deposit.",
       "account_id": jb, "contract": j, "public_key": pk, "secret_key": sk}
json.dump(out, open("docs/console/agent.json", "w"), indent=2); open("docs/console/agent.json", "a").write("\n")
t = open(".gitleaks.toml").read()
if pk not in t:
    lines = ("  # The Judge mode demo key (docs/console/agent.json): PUBLIC on purpose, fenced to " + j + "\n" +
             "".join(f"  '''^{v}$''',\n" for v in (sk, sk.split(':')[1], pk, pk.split(':')[1])))
    t = re.sub(r"\n\]\n", "\n" + lines + "]\n", t, count=1)
    open(".gitleaks.toml", "w").write(t)
print("wrote docs/console/agent.json; added the demo key to .gitleaks.toml")
PY

echo
echo "Done. Next: scripts/judge-cases.sh (signs the honest demo invoices into docs/console/cases.json)."
echo "Honest runs CLEAR from: (see route_payable_from above, 72 hours after step 4)."
