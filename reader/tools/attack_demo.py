"""Attack demo, part 1: what a poisoned invoice tells a naive agent, and what our reader lets through.

Run from reader/:  python3 tools/attack_demo.py
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from pdfminer.high_level import extract_text  # noqa: E402

from ctp_reader.isolated import prepare_isolated  # noqa: E402

PDF = HERE / "corpus" / "02-white-text-payee.pdf"


def lines(text: str) -> list[str]:
    return [l.strip() for l in text.splitlines() if l.strip()]


def main() -> int:
    print(f"[attack] the invoice: {PDF.name} (white text on a white page)")
    naive = lines(extract_text(str(PDF)))
    print("[naive]  a plain text dump, which is what most agents feed the model:")
    for l in naive:
        print(f"           {l}")
    p = prepare_isolated(PDF)
    shown = set(lines(p.text))
    hidden = [l for l in naive if l not in shown]
    print("[reader] lines a person cannot see, cut before any model reads the page:")
    for l in hidden:
        print(f"           - {l}")
    for d in p.dropped:
        if d.text:
            print(f"           reason: {d.reason}")
            break
    verdict = "HELD" if p.held else "READY"
    print(f"[reader] verdict: {verdict} {p.held}")
    print("[reader] the model is never called for this invoice.")
    ok = p.held == ["hidden_text"] and hidden
    print("[result] STOPPED at the reader" if ok else "[result] UNEXPECTED: check the reader")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
