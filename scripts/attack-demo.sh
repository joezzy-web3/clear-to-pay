#!/usr/bin/env bash
# Clear to Pay attack demo: a poisoned invoice, an agent that believes it, and every "no".
#
#   scripts/attack-demo.sh            anyone: no wallet, no keys (needs Rust and Python)
#   scripts/attack-demo.sh --onchain  the project owner only: the same attack against the live
#                                     testnet contract, signed with the agent's fenced key
#
# The log is printed and saved to attack-demo.log.
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=attack-demo.log
: > "$LOG"
say() { echo "$*" | tee -a "$LOG"; }
run() { "$@" 2>&1 | tee -a "$LOG"; return "${PIPESTATUS[0]}"; }

C=guard.cleartopay.testnet
BUYER=buyer.cleartopay.testnet
USDC=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
NET="network-config testnet"

say "== 1. The poisoned invoice reaches the reader ====================================="
(cd reader && run python3 tools/attack_demo.py) || say "[!] reader step failed (is pdfminer.six installed? see README)"

say ""
say "== 2. Suppose the AI was fooled anyway: the contract decides ======================="
run cargo test -q demo_a_fooled_agent_is_stopped_by_the_contract -- --nocapture \
  | grep -E '^\[' || say "[!] contract step failed"

say ""
say "== 3. The agent's key, as recorded on chain (anyone can check this) ================"
if command -v near >/dev/null; then
  run near account list-keys "$BUYER" $NET now
else
  say "(near CLI not installed; the same list is at https://testnet.nearblocks.io/address/$BUYER under Keys)"
fi

if [ "${1:-}" != "--onchain" ]; then
  say ""
  say "Done. Log saved to $LOG. The on-chain refusals (section 4) are in docs/testnet-proof.md."
  exit 0
fi

# ------------------------------------------------------------------ owner only: live refusals
AGENT_PUB=6ZnC3JFuTwHksSLZev3Vbbe24hjKdZs52gFphrLctcWp
AGENT_KEY_FILE="$HOME/.near-credentials/testnet/$BUYER/ed25519_${AGENT_PUB}.json"
[ -f "$AGENT_KEY_FILE" ] || { say "[!] agent key file not found: $AGENT_KEY_FILE"; exit 1; }
as_agent() { # as_agent <receiver> <method> <json> <deposit>
  near contract call-function as-transaction "$1" "$2" json-args "$3" \
    prepaid-gas '100.0 Tgas' attached-deposit "$4" \
    sign-as "$BUYER" $NET sign-with-access-key-file "$AGENT_KEY_FILE" send 2>&1
}
verdict() { # classify what happened to one attempt
  local out="$1"
  if echo "$out" | grep -qi "isn't allowed by the access key\|is not allowed by the access key"; then echo "REFUSED BY NEAR: method not allowed for this key (no transaction created)"
  elif echo "$out" | grep -qi "deposit with a function call action is not allowed"; then echo "REFUSED BY NEAR: a function-call key cannot attach money (no transaction created)"
  elif echo "$out" | grep -qi "doesn't match the access key\|does not match the access key"; then echo "REFUSED BY NEAR: this key only works on $C (no transaction created)"
  elif echo "$out" | grep -qi "panicked\|ExecutionError\|Smart contract"; then echo "REFUSED BY THE CONTRACT: failed transaction, recorded on chain"
  elif echo "$out" | grep -q '"Seized"\|Seized'; then echo "STOPPED BY THE CONTRACT: verdict SEIZED, recorded on chain"
  else echo "UNEXPECTED: read the output above"; fi
}
tx() { echo "$1" | grep -Eo 'Transaction ID: [1-9A-HJ-NP-Za-km-z]{32,64}' | head -1; }

attempt() { # attempt <label> <receiver> <method> <json> <deposit>
  say ""
  say "--- $1"
  local out; out=$(as_agent "$2" "$3" "$4" "$5")
  echo "$out" >> "$LOG"
  echo "$out" | grep -E "Error|error|allowed|match|panicked|Seized|Transaction ID" | head -4
  say "[result] $(verdict "$out") $(tx "$out")"
}

say ""
say "== 4. Live on testnet: the agent's key tries what it must not ======================"
read -r -p "This sends real testnet calls with the agent key. Enter to continue, Ctrl+C to stop " _
attempt "Withdraw the pool to the buyer (an owner method)" "$C" withdraw "{\"token\":\"$USDC\",\"amount\":\"1000000\"}" '0 NEAR'
attempt "Attach 1 yoctoNEAR, the token every owner action requires, to an allowed method" "$C" submit_invoice '{}' '1 yoctoNEAR'
attempt "Change the limits (an owner method), with 1 yoctoNEAR" "$C" set_limits '{"per_invoice":"1000000000","per_supplier_per_period":"1000000000","period_hours":"720","max_submissions_per_day":1000}' '1 yoctoNEAR'
attempt "Send USDC straight to an attacker" "$USDC" ft_transfer '{"receiver_id":"qingmar-payments.testnet","amount":"1000000"}' '1 yoctoNEAR'
attempt "Pay a receipt that does not exist" "$C" execute_payment '{"receipt_id":999}' '0 NEAR'

say ""
say "--- The poisoned invoice itself: payee = qingmar-payments.testnet, every signature valid"
say ""
say ">>> The signing tool will now show the poisoned invoice. That is intended."
say ">>> Type the full word   yes   and press Enter to sign and submit it."
say ""
ARGS=$(cargo run -q --manifest-path tools/ctp-sign/Cargo.toml -- submit-args qingmar-supplier \
  lagos-storekeeper:storekeeper,lagos-weighbridge:weighbridge "$C" \
  demo/INV-2210/invoice.json demo/INV-2210/delivery.json demo/INV-2210/document.txt)
out=$(as_agent "$C" submit_invoice "$ARGS" '0 NEAR'); echo "$out" >> "$LOG"
echo "$out" | grep -E "verdict|reasons|Seized|Transaction ID" | head -6
say "[result] $(verdict "$out") $(tx "$out")"

say ""
say "Done. Log saved to $LOG. Send the [result] lines and transaction IDs for the proof log."
