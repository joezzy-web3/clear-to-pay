"""Read one document from stdin, run it through `prepare_bytes`, print the result as JSON.

Started by `isolated.prepare_isolated` as a separate, limited process (see there).
It is given the document's bytes, not a path, and an empty environment.
"""

import json
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ctp_reader import prepare_bytes  # noqa: E402

if __name__ == "__main__":
    raw = sys.stdin.buffer.read()
    p = prepare_bytes(raw)
    sys.stdout.write(json.dumps(asdict(p), ensure_ascii=False))
