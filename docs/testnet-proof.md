# Clear to Pay on NEAR testnet: proof log

Live contract: **guard.cleartopay.testnet** (v2, with the audit fixes; owner: buyer.cleartopay.testnet)
Retired contract: cleartopay.testnet (v1; its first verdicts stay below as history)
USDC (Circle, NEAR testnet): 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
Every transaction below links to NearBlocks.

## 30 Oct 2026, v2 deployed after the security review
Patch 7 changes what suppliers sign and how state is stored, so it went to a fresh account rather than over v1.
- 15 test USDC withdrawn from v1 back to the buyer (v1 refused a second withdrawal: "not enough unreserved funds"): [7x4bzE1F…](https://testnet.nearblocks.io/txns/7x4bzE1F7qzMzA3NDkeMHKchuQm1TPbnN64UsgKeZmhe)
- guard.cleartopay.testnet created: [EPCAL1NM…](https://testnet.nearblocks.io/txns/EPCAL1NMXoEhyAsQD1YovcN9p4ptcHpAsKUcCYtHMwju)
- Contract deployed and initialised (wasm sha-256 94f2ebab…db880): [AcLCZwrf…](https://testnet.nearblocks.io/txns/AcLCZwrfdQH3hojwCVJz1Fd6ftAosviGQfvP2zG7r11x)
- Registered with the USDC token: [AkbZh8Rt…](https://testnet.nearblocks.io/txns/AkbZh8RtNUmAugW3mMizBnf4uXERrtjp4DvrYbnYMud9)
- USDC allowed: [5gMeNYsz…](https://testnet.nearblocks.io/txns/5gMeNYszVA28X34F6m8syCVMUW5hquZSg64oNHafxL5G)
- Supplier qingmar-steel (fictional) registered; payable from Mon 2 Nov 2026 23:29 Lagos: [SihRASoT…](https://testnet.nearblocks.io/txns/SihRASoT9STgAd5MvujyFiHkNBaqGM28aBAQsrEFCQN)
- Storekeeper key added (a different key from the supplier's, as v2 requires): [57NPNH66…](https://testnet.nearblocks.io/txns/57NPNH66GgxgqgByNPqaQ6PrcaGPpgET93eeFX5eLdNR)
- Order PO-1184 created: [ETVTZCgX…](https://testnet.nearblocks.io/txns/ETVTZCgXsxyTruS4J8uP8S6uuqYGoPRi2yu4McDwNUxq)
- Limits set (10 USDC per invoice, 30 per supplier per 30 days, 100 submissions a day): [3bZPM4mK…](https://testnet.nearblocks.io/txns/3bZPM4mKsikVTHUS7s2cqj1gnZNpzzQ1c1rPEiN1kHzA)
- New agent function-call key ed25519:6ZnC3JFuTwHksSLZev3Vbbe24hjKdZs52gFphrLctcWp: receiver guard.cleartopay.testnet only, methods submit_invoice and execute_payment only, 0.25 NEAR gas allowance: [2GQ6or4U…](https://testnet.nearblocks.io/txns/2GQ6or4UY17dbeQDQ7YCSRtQ2zmcbCbrBcHSZGM9suYn)
- 15 test USDC deposited: [GVPqFRwi…](https://testnet.nearblocks.io/txns/GVPqFRwiVPt2xWwCPLUY7Bh9KHHNdC9aZ3DP5Z5bEdeQ)
- 31 Oct: 25 more test USDC deposited (Circle faucet), pool now 40 USDC: [37MqaoBv…](https://testnet.nearblocks.io/txns/37MqaoBvbgZADP7r9GswqwBtezCnZAvrr3MCZ63gdbXJ)

## 31 Oct 2026, v2.1: second-audit fixes deployed in place
The contract's stored layout did not change, so the code was upgraded on the same account: the supplier, the order, the limits, the 40 USDC and the 72-hour clock are untouched (checked before and after with `get_funds` and `get_supplier`).
- 1 NEAR sent to the contract for storage and the 0.05 NEAR write reserve: [Gs52QsUW…](https://testnet.nearblocks.io/txns/Gs52QsUWWS8PSAGJZ8AoPgpnn9DttBLWPEvjxJhxwCXM)
- New code deployed without re-initialising (wasm sha-256 7e45785b…a4e2f0): [FV8cmybT…](https://testnet.nearblocks.io/txns/FV8cmybTw3BeYGBZjAPNq9H3LnzyWgy4TahrQ1zPxgyC)
- After the upgrade: `get_funds` 40 USDC available, 0 reserved; `get_in_flight` (new) 0 payouts, 0 withdrawing; supplier still payable from Mon 2 Nov 2026 23:29 Lagos.
- What this shows: the upgrade kept this state, at a moment with no receipts and nothing in flight. It is not a test of upgrading with transfers in flight; upgrades are now made only when `get_in_flight` reads zero (`scripts/upgrade-in-place.sh`).

# v1 history (cleartopay.testnet)

## 30 Oct 2026, setup
- Contract deployed and initialised: [FbVwuaGq…](https://testnet.nearblocks.io/txns/FbVwuaGqeZ3bXR8dENbFARDkoYsryV5gVyfEJsGNURk)
- USDC allowed: [Do4gKQK6…](https://testnet.nearblocks.io/txns/Do4gKQK6CtvMXCuzqHToFXUwGbtTjx87ZVHk5fxZfV21)
- Limits set (10 USDC per invoice, 30 per supplier per 30 days): [629jaUAj…](https://testnet.nearblocks.io/txns/629jaUAjnTZyFQ3BxGn3jmQNtKNDRRLfq9dGsuC4W4SJ)
- Storekeeper key added: [9Y6MwfP5…](https://testnet.nearblocks.io/txns/9Y6MwfP5P91v7cDaJzByLTQXUz9vbSa1bopHn9m3UvzE)
- Supplier qingmar-steel (fictional) registered; payable from Mon 2 Nov 2026 21:17 Lagos: [ZX8bzqSq…](https://testnet.nearblocks.io/txns/ZX8bzqSqVNZcaMB58qJB1moTWgqDC2EAoYZrwMXGhVr)
- Order PO-1184 created: [7SF6CGek…](https://testnet.nearblocks.io/txns/7SF6CGekGn4iBqZJwNP5f5wpCThM6jhQWBPJ4Td8Huk6)
- 15 test USDC deposited: [BUpVeQur…](https://testnet.nearblocks.io/txns/BUpVeQurtsVS4QbDHsrAJdzmy8Jn1y2WMCmWMMG8J7B3)

## 30 Oct 2026, the agent key
- Function-call key ed25519:GVTR1DmhqJaiLpNfhMRq7Y5rrERKCdmjwZHZnkRbDXra added to buyer.cleartopay.testnet: receiver cleartopay.testnet only, methods submit_invoice and execute_payment only, 0.25 NEAR gas allowance: [8HpViCur…](https://testnet.nearblocks.io/txns/8HpViCurkLKMHW717hJ93ae1A7hFL27Uit1CWD8d1RkX)

## 30 Oct 2026, first verdicts
- INV-2209, billed 12 t / delivered 10 t: HELD [payee_not_yet_payable, quantity_exceeds_delivery], receipt 0: [4NAEWuuj…](https://testnet.nearblocks.io/txns/4NAEWuuj94LJtSN3kZRWfWNjAmVqryL6Q1QmnkjYUQFg)
- INV-2210, "new bank details" (payee not on file): SEIZED [payee_mismatch], receipt 1: [7WyaoQhm…](https://testnet.nearblocks.io/txns/7WyaoQhmqEZS2dYhxmrgBQ6WBdgiJWEgpKr5WNdx9xAM)

## 30 Oct 2026, the agent key is fenced (refused before reaching the chain, so no transaction IDs)
Signed with the agent's function-call key (the GVTR1Dmh… key above):
- `submit_invoice` with 0 deposit: allowed; INV-2209 HELD again, receipt 2: [HgiFFPzQ…](https://testnet.nearblocks.io/txns/HgiFFPzQmrjzXNQXvEuDKgQnQtrQqQDmZcBV1LpbcfMg)
- `allow_token` with 1 yoctoNEAR: refused ("Having a deposit with a function call action is not allowed with a function call access key")
- `submit_invoice` with 1 yoctoNEAR: refused (same rule)
- USDC `ft_transfer` with 1 yoctoNEAR: refused (same rule)
- `allow_token` with 0 deposit: refused ("Transaction method name <allow_token> isn't allowed by the access key")
- USDC `storage_withdraw` with 0 deposit: refused ("Transaction for <3e2210…afcb8af> doesn't match the access key for <cleartopay.testnet>")
