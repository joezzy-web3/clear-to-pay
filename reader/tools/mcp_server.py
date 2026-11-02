"""Run Clear to Pay as an MCP server over stdio (see ctp_reader/mcp_server.py). Standard library only.

  python3 tools/mcp_server.py            # an MCP client starts this; it speaks JSON-RPC on stdin/stdout
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ctp_reader.mcp_server import serve  # noqa: E402

if __name__ == "__main__":
    serve()
