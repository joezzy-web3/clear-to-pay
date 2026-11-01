"""Watch the contract and send alerts to Telegram (or just print them).

Run from reader/ (keys come from your environment, loaded from .env; never printed):

  python3 tools/alerts.py --dry-run --once       # print what would be sent, once
  python3 tools/alerts.py --test                 # send one test message to your Telegram
  python3 tools/alerts.py                        # watch every 30 s and send alerts

The first run only remembers what already happened (add --replay to announce it).
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from ctp_reader import alerts, chain  # noqa: E402
from ctp_reader import model as M  # noqa: E402

USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--contract", default=chain.CONTRACT)
    ap.add_argument("--suppliers", default="qingmar-steel", help="comma-separated supplier ids to watch")
    ap.add_argument("--token", default=USDC)
    ap.add_argument("--every", type=int, default=30, help="seconds between polls")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="print alerts; do not send")
    ap.add_argument("--replay", action="store_true", help="on the first run, announce what already happened")
    ap.add_argument("--test", action="store_true", help="send one test message and exit")
    ap.add_argument("--state", default=None, help="where to remember what was seen")
    a = ap.parse_args()

    if a.test:
        try:
            alerts.telegram(f"Clear to Pay alerts are connected for {a.contract}. You will hear about address changes, "
                            f"HELD and SEIZED invoices, payments and signer changes here.")
        except RuntimeError as e:
            print(f"[telegram] {e}")
            return 1
        print("[telegram] test message sent; check your phone")
        return 0

    state = Path(a.state) if a.state else M.cache_dir() / f"alerts-{a.contract}.json"
    send = print if a.dry_run else alerts.telegram
    suppliers = [s for s in a.suppliers.split(",") if s]
    first = not state.exists()
    while True:
        try:
            got = alerts.tick(view=alerts.view_for(a.contract), suppliers=suppliers, token=a.token,
                              state_path=state, send=send, contract=a.contract, replay=a.replay)
            stamp = time.strftime("%H:%M:%S")
            if first and not a.replay:
                print(f"[{stamp}] watching {a.contract}; what already happened is remembered, not announced")
            else:
                print(f"[{stamp}] {len(got)} alert(s)")
            first = False
        except (chain.ChainError, RuntimeError) as e:
            print(f"[{time.strftime('%H:%M:%S')}] could not check this time: {e}")  # state untouched; retried next poll
        if a.once:
            return 0
        time.sleep(a.every)


if __name__ == "__main__":
    sys.exit(main())
