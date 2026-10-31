"""Run one document through `prepare` and print the result as JSON.

Started by `isolated.prepare_isolated` as a separate process with hard limits on
memory, CPU time and file writes, so a hostile PDF can only kill this process.
"""

import json
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ctp_reader import prepare  # noqa: E402

if __name__ == "__main__":
    p = prepare(sys.argv[1])
    out = asdict(p)
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
