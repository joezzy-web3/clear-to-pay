"""Clear to Pay invoice reader: everything around the AI, none of the authority.

    intake.read_pdf      keep only glyphs a person can see; HOLD on hidden payment text
    normalize.clean      Unicode clean-up; HOLD on zero-width, bidi, mixed scripts
    schema.parse         the AI's answer must fit a fixed shape, or it is rejected
    schema.check         totals and amounts-in-words must agree
    schema.to_invoice    contract JSON; token from the order, payee from the registry

`prepare()` runs the document steps and returns what the model may see, or the
reasons the invoice is HELD before any model is called. For untrusted documents
use `isolated.prepare_isolated()`, which runs the same steps in a separate process
with memory, CPU and file-write limits.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .intake import Dropped, read_pdf, read_pdf_bytes
from .normalize import clean


@dataclass
class Prepared:
    sha256: str
    text: str
    held: list[str] = field(default_factory=list)
    dropped: list[Dropped] = field(default_factory=list)
    mixed_script_tokens: list[str] = field(default_factory=list)

    @property
    def ready(self) -> bool:
        return not self.held


def prepare(path: str | Path) -> Prepared:
    return _prepared(read_pdf(path))


def prepare_bytes(raw: bytes) -> Prepared:
    return _prepared(read_pdf_bytes(raw))


def _prepared(intake) -> Prepared:
    c = clean(intake.visible_text)
    return Prepared(
        sha256=intake.sha256,
        text=c.text,
        held=sorted(set(intake.held) | set(c.held)),
        dropped=intake.dropped,
        mixed_script_tokens=c.mixed_script_tokens,
    )
