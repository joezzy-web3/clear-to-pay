#!/usr/bin/env bash
# Proves the secret scan still catches real secrets next to the public values it
# allows. Fake secrets are generated at run time, so none is ever committed.
set -euo pipefail
GITLEAKS="${GITLEAKS:-gitleaks}"
CONFIG="$(cd "$(dirname "$0")/.." && pwd)/.gitleaks.toml"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

b58() { python3 -c "import secrets;a='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';print(''.join(secrets.choice(a) for _ in range($1)))"; }
USDC=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
AGENT=ed25519:GVTR1DmhqJaiLpNfhMRq7Y5rrERKCdmjwZHZnkRbDXra

expect() { # expect <caught|clean> <name> <content>
  mkdir -p "$work/$2" && printf '%s\n' "$3" > "$work/$2/file.txt"
  if "$GITLEAKS" detect --no-git --no-banner --source "$work/$2" -c "$CONFIG" >/dev/null 2>&1; then got=clean; else got=caught; fi
  if [ "$got" != "$1" ]; then echo "FAIL: $2 was $got, expected $1"; exit 1; fi
  echo "ok: $2 ($got)"
}

expect clean  public_values_alone        "token=$USDC agent=$AGENT"
expect caught near_secret_beside_pubkey  "agent=$AGENT secret=ed25519:$(b58 88)"
expect caught near_secret_beside_usdc    "\"token\": \"$USDC\", \"key\": \"ed25519:$(b58 88)\""
expect caught api_key_beside_usdc        "token=$USDC api_key=\"$(b58 40)\""
expect caught near_ai_key_in_env         "NEAR_AI_API_KEY=sk-$(b58 40)"
echo "secret scan self-test passed"
