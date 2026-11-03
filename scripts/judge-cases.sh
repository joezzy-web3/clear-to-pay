#!/usr/bin/env bash
# Clear to Pay: sign the honest Judge mode invoices into docs/console/cases.json.
#
# The contract pays each invoice once (invoice number, document fingerprint and
# delivery note are all remembered). So every honest run in Judge mode needs its own
# numbered copy of INV-2208: 1 t of AH36-12mm on order PO-J1 (0.78 USDC), delivered
# and signed by the storekeeper and the weighbridge, signed by the supplier. This
# script makes N of them with the same keys as demo/README.md. No private key goes
# into the file: only signatures. The attack run in the page reuses the next unused
# copy with the payee swapped, which breaks the supplier signature and is SEIZED
# without using the copy up.
#
# Usage (repo root): scripts/judge-cases.sh [N]     (default 20)
set -euo pipefail

N=${1:-20}
J=judge.cleartopay.testnet
CTP="cargo run -q --manifest-path tools/ctp-sign/Cargo.toml --"
SIGNERS=lagos-storekeeper:storekeeper,lagos-weighbridge:weighbridge
ORIG=$(sha256sum reader/corpus/01-clean.pdf | cut -d' ' -f1)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

echo "Signing $N honest copies of INV-2208 for $J (supplier + two delivery signers)..."
for k in $(seq -w 1 "$N"); do
  python3 - "$k" "$ORIG" "$TMP" <<'PY'
import json, sys
k, orig, d = sys.argv[1], sys.argv[2], sys.argv[3]
route = json.load(open("demo/route-qingmar.json"))
inv = {"supplier_id": "qingmar-steel", "invoice_number": f"INV-2208-J{k}", "order_id": "PO-J1",
       "token": route["token"], "lines": [{"sku": "AH36-12mm", "qty": "1", "unit_price": "780000"}],
       "total": "780000", "payee": route}
note = {"order_id": "PO-J1", "note_id": f"DN-J{k}", "lines": [{"sku": "AH36-12mm", "qty": "1"}]}
doc = (f"SAMPLE DOCUMENT - FICTIONAL COMPANY - NOT A REAL INVOICE\n\n"
       f"Judge mode copy {k} of Qingmar Steel Co. invoice INV-2208 (reader/corpus/01-clean.pdf, sha256 {orig}).\n"
       f"Invoice INV-2208-J{k}, order PO-J1: 1 t AH36 steel plate 12 mm at 0.78 USDC. Total 0.78 USDC.\n"
       f"Payment: to the account registered with Clear to Pay.\n")
json.dump(inv, open(f"{d}/inv.json", "w")); json.dump(note, open(f"{d}/note.json", "w"))
open(f"{d}/doc.txt", "w").write(doc)
PY
  $CTP --yes submit-args qingmar-supplier "$SIGNERS" "$J" "$TMP/inv.json" "$TMP/note.json" "$TMP/doc.txt" \
    > "$TMP/args-$k.json" 2> "$TMP/err" || { cat "$TMP/err"; exit 1; }
  printf '.'
done
echo

python3 - "$N" "$TMP" "$J" <<'PY'
import json, sys, datetime
n, d, j = int(sys.argv[1]), sys.argv[2], sys.argv[3]
cases = [json.load(open(f"{d}/args-{k:0{len(str(n))}d}.json")) for k in range(1, n + 1)]
out = {"contract": j, "order_id": "PO-J1", "attacker_payee": "qingmar-payments.testnet",
       "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
       "cases": cases}
json.dump(out, open("docs/console/cases.json", "w"), indent=1); open("docs/console/cases.json", "a").write("\n")
print(f"wrote docs/console/cases.json ({n} cases)")
PY
