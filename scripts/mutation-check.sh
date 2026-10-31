#!/usr/bin/env bash
# Prove the property tests can fail: break the contract on purpose, one rule at a time,
# in a throwaway copy, and require a property test to catch every break.
# Usage: scripts/mutation-check.sh        (from the repository root; takes a few minutes)
set -euo pipefail
ROOT=$(pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
export CARGO_TARGET_DIR="$ROOT/target/mutation"

# name | file | exact line to replace | replacement | property test that must catch it
MUTANTS=(
  "payee check removed|src/inspection.rs|                if payable.as_ref() != Some(&invoice.payee) {|                if false {|property_random_action_sequences_keep_every_money_rule"
  "refund on a failed transfer removed|src/payments.rs|        if !supplier_was_paid {|        if false {|property_random_action_sequences_keep_every_money_rule"
  "two-person delivery rule removed|src/inspection.rs|                if roles_signed.len() < policy.required as usize {|                if false {|property_a_delivery_needs_exactly_two_valid_roles"
)

caught=0
for m in "${MUTANTS[@]}"; do
  IFS='|' read -r name file from to test <<<"$m"
  echo "building and testing: $name (a few minutes)..."
  rm -rf "$WORK/src" && cp -r "$ROOT/Cargo.toml" "$ROOT/Cargo.lock" "$ROOT/src" "$WORK/" 2>/dev/null
  cp "$ROOT/rust-toolchain.toml" "$WORK/" 2>/dev/null || true
  python3 - "$WORK/$file" "$from" "$to" <<'PY'
import sys
path, a, b = sys.argv[1:]
s = open(path).read()
assert s.count(a) == 1, f"mutation target not found exactly once in {path}"
open(path, "w").write(s.replace(a, b))
PY
  if (cd "$WORK" && cargo test -q "$test" >/dev/null 2>&1); then
    echo "NOT CAUGHT: $name"
  else
    echo "caught:     $name"
    caught=$((caught + 1))
  fi
done
echo "$caught of ${#MUTANTS[@]} deliberate breaks caught by the property tests"
[ "$caught" -eq "${#MUTANTS[@]}" ]
