"""Read one document from stdin, run it through `prepare_bytes`, print the result as JSON.

Started by `isolated.prepare_isolated` as a separate, limited process (see there).
It is given the document's bytes, not a path, and an empty environment.
"""

import json
import sys
from dataclasses import asdict
from pathlib import Path

# Library folders the parent process imports from (passed as JSON, because the child
# runs with `-I` and an empty environment and would otherwise miss --user installs).
if len(sys.argv) > 1:
    for p in reversed(json.loads(sys.argv[1])):
        if isinstance(p, str) and p not in sys.path:
            sys.path.insert(0, p)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ctp_reader import prepare_bytes  # noqa: E402

if __name__ == "__main__":
    raw = sys.stdin.buffer.read()
    p = prepare_bytes(raw)
    sys.stdout.write(json.dumps(asdict(p), ensure_ascii=False))
