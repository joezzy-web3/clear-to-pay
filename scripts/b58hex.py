"""Read a NEAR RPC view_account answer on stdin and print its code_hash as hex sha-256.
NEAR shows code hashes in base58; CI compares them with sha256sum output. Used by .github/workflows/ci.yml."""
import json
import sys

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = 0
for c in json.load(sys.stdin)["result"]["code_hash"]:
    n = n * 58 + ALPHABET.index(c)
print("%064x" % n)
