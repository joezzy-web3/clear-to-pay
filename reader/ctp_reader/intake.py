"""PDF intake: read an invoice glyph by glyph and keep only what a person can see.

An AI that reads a flattened text dump also reads text no human sees: white on
white, microscopic fonts, invisible render modes, text outside the page, or text
hidden under a box drawn on top of it. That is where "pay the new account today"
hides. So before any model sees an invoice, every glyph is checked, and the ones a
person cannot see are dropped and logged.

If dropped text talks about payment (a wallet, bank, account, amount or address),
the invoice is HELD with reason `hidden_text`. Hidden text that says nothing about
payment (e.g. a white "draft v2") is dropped and logged, and the invoice goes on.

Visibility is judged by contrast against what is painted behind the glyph (the
page, or a filled box drawn earlier), so white text on a dark header bar is
visible and dark text on a dark box is not. Outline-only text is judged by its
outline colour. A glyph counts as covered when a quarter or more of it lies under
shapes or images painted later. A page that is a full-page image with no visible
text layer (a scan) is HELD until the rendered-image check exists.

Not covered here (stated, not claimed): clipping paths, transparency (soft masks,
fill opacity), and text over photographs (the colour behind it is unknown, so it
counts as visible). The planned rendered-image comparison covers those; until then
the payee rule is the backstop: the payee never comes from the document.
"""

from __future__ import annotations

import hashlib
import io
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from pdfminer.converter import PDFPageAggregator
from pdfminer.layout import LTChar, LTContainer, LTCurve, LTImage, LTRect
from pdfminer.pdfinterp import PDFPageInterpreter, PDFResourceManager
from pdfminer.pdfpage import PDFPage

# Thresholds for "a person cannot see this".
MIN_FONT_SIZE = 2.0  # points; normal invoice text is 8-12 pt
MIN_GLYPH_WIDTH = 0.5  # points; catches horizontal squashing to nothing
MIN_CONTRAST = 0.12  # luminance difference below which text is not readable
COVERED_SHARE = 0.25  # share of a glyph under later paint that counts as hidden
FILL_MODES = {0, 2, 4, 6}
STROKE_MODES = {1, 2, 5, 6}
INVISIBLE_RENDER_MODES = {3, 7}  # 3 = neither fill nor stroke, 7 = clip only
SCANNED_IMAGE_SHARE = 0.8  # an image covering 80% of a page = scanned page

MAX_PAGES = 20
MAX_BYTES = 10 * 1024 * 1024

PAYMENT_WORDS = re.compile(
    r"pay|wallet|account|acct|bank|iban|swift|bic|routing|sort\s*code|transfer|remit|"
    r"beneficiar|usdc|usdt|address|amount|invoice|total|\.near\b|\.testnet\b|"
    r"0x[0-9a-f]{6,}|\d{4,}",
    re.IGNORECASE,
)


@dataclass
class Dropped:
    page: int
    reason: str
    text: str


@dataclass
class Intake:
    sha256: str
    pages: int
    visible_text: str
    dropped: list[Dropped] = field(default_factory=list)
    held: list[str] = field(default_factory=list)


class _GlyphDevice(PDFPageAggregator):
    """pdfminer's aggregator, plus the text render mode on every glyph."""

    def render_string(self, textstate, seq, ncs, graphicstate):
        self._render_mode = textstate.render
        return super().render_string(textstate, seq, ncs, graphicstate)

    def render_char(self, *args, **kwargs):
        adv = super().render_char(*args, **kwargs)
        self.cur_item._objs[-1].render_mode = getattr(self, "_render_mode", 0)
        return adv


def _flatten(container):
    """Every object in drawing order (later objects are painted on top)."""
    for obj in container:
        yield obj
        if isinstance(obj, LTContainer) and not isinstance(obj, LTChar):
            yield from _flatten(obj)


def _luminance(colour, space_name: str) -> float | None:
    if colour is None:
        return None
    if isinstance(colour, (int, float)):
        colour = (colour,)
    try:
        c = [float(x) for x in colour]
    except (TypeError, ValueError):
        return None  # pattern or named colour: unknown, treat as visible
    if len(c) == 1:
        return c[0]
    if len(c) == 3:
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    if len(c) == 4:  # CMYK
        r, g, b = ((1 - c[i]) * (1 - c[3]) for i in range(3))
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    return None


def _inside(x: float, y: float, box) -> bool:
    x0, y0, x1, y1 = box
    return x0 <= x <= x1 and y0 <= y <= y1


def _overlap(a, b) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


def _visible_colour(ch: LTChar, background: float | None) -> bool:
    """True if the glyph's fill or outline stands out from what is behind it."""
    mode = getattr(ch, "render_mode", 0)
    bg = 1.0 if background is None else background
    colours = []
    if mode in FILL_MODES:
        colours.append(_luminance(ch.graphicstate.ncolor, ""))
    if mode in STROKE_MODES:
        colours.append(_luminance(ch.graphicstate.scolor, ""))
    for lum in colours:
        if lum is None or abs(lum - bg) >= MIN_CONTRAST:
            return True  # unknown colours count as visible
    return False


def _why_hidden(ch: LTChar, page_box, background, later_covers) -> str | None:
    # Format characters (zero-width, bidi controls) have no width by nature; they
    # are passed on so the Unicode clean-up can see and flag them.
    if any(unicodedata.category(c) == "Cf" for c in ch.get_text()):
        return None
    if getattr(ch, "render_mode", 0) in INVISIBLE_RENDER_MODES:
        return "invisible_render_mode"
    if ch.size < MIN_FONT_SIZE:
        return "tiny_font"
    if ch.width < MIN_GLYPH_WIDTH and not ch.get_text().isspace():
        return "squashed_glyph"
    if not _visible_colour(ch, background):
        return "white_text" if background is None else "low_contrast"
    cx, cy = (ch.x0 + ch.x1) / 2, (ch.y0 + ch.y1) / 2
    if not _inside(cx, cy, page_box):
        return "outside_page"
    box = (ch.x0, ch.y0, ch.x1, ch.y1)
    area = max((ch.x1 - ch.x0) * (ch.y1 - ch.y0), 1e-9)
    if sum(_overlap(box, c) for c in later_covers) >= COVERED_SHARE * area:
        return "covered_by_shape_or_image"
    return None


def read_pdf(path: str | Path) -> Intake:
    p = Path(path)
    if p.stat().st_size > MAX_BYTES:  # checked before anything is read
        raise ValueError("document larger than 10 MB")
    return read_pdf_bytes(p.read_bytes())


def read_pdf_bytes(raw: bytes) -> Intake:
    """Same as `read_pdf`, for a document already in memory (the isolated worker gets it on stdin)."""
    if len(raw) > MAX_BYTES:
        raise ValueError("document larger than 10 MB")
    if not raw.startswith(b"%PDF-"):
        raise ValueError("not a PDF")
    digest = hashlib.sha256(raw).hexdigest()

    rm = PDFResourceManager()
    device = _GlyphDevice(rm, laparams=None)
    interp = PDFPageInterpreter(rm, device)
    visible_pages: list[str] = []
    dropped: list[Dropped] = []
    held: set[str] = set()
    n = 0
    with io.BytesIO(raw) as f:
        for n, page in enumerate(PDFPage.get_pages(f), start=1):
            if n > MAX_PAGES:
                raise ValueError("more than 20 pages")
            interp.process_page(page)
            layout = device.get_result()
            objs = list(_flatten(layout))
            page_box = layout.bbox
            page_area = max((page_box[2] - page_box[0]) * (page_box[3] - page_box[1]), 1.0)

            chars = [o for o in objs if isinstance(o, LTChar)]
            images = [o for o in objs if isinstance(o, LTImage)]
            big_image = any(
                (i.x1 - i.x0) * (i.y1 - i.y0) >= SCANNED_IMAGE_SHARE * page_area for i in images
            )
            scanned = big_image and all(
                getattr(c, "render_mode", 0) in INVISIBLE_RENDER_MODES for c in chars
            )
            if scanned:
                # A scanned page: either no text layer at all, or an invisible OCR
                # layer. Neither can be trusted until it is compared with the image
                # (planned), so the invoice is held. Its invisible text is the OCR
                # layer itself, not a separate trick.
                held.add("scanned_document")

            line: list[str] = []
            lines: list[str] = []
            hidden_runs: dict[str, list[str]] = {}
            last_y = None
            # Filled shapes and images, in drawing order, with their colour
            # (None for images: what they show behind a glyph is unknown).
            painters = []
            for i, c in enumerate(objs):
                if isinstance(c, LTImage):
                    painters.append((i, (c.x0, c.y0, c.x1, c.y1), "image"))
                elif isinstance(c, (LTRect, LTCurve)) and getattr(c, "fill", False):
                    lum = _luminance(getattr(c, "non_stroking_color", None), "")
                    painters.append((i, (c.x0, c.y0, c.x1, c.y1), lum))
            for idx, o in enumerate(objs):
                if not isinstance(o, LTChar):
                    continue
                cx, cy = (o.x0 + o.x1) / 2, (o.y0 + o.y1) / 2
                behind = [p for p in painters if p[0] < idx and _inside(cx, cy, p[1])]
                background = None
                if behind:
                    top = behind[-1][2]
                    background = "unknown" if top == "image" or top is None else top
                if background == "unknown":
                    background = -10.0  # any colour contrasts with an unknown picture
                covers = [box for i, box, _ in painters if i > idx]
                why = _why_hidden(o, page_box, background, covers)
                if why:
                    hidden_runs.setdefault(why, []).append(o.get_text())
                    continue
                if last_y is not None and abs(o.y0 - last_y) > o.size * 0.5:
                    lines.append("".join(line))
                    line = []
                line.append(o.get_text())
                last_y = o.y0
            if line:
                lines.append("".join(line))
            visible_pages.append("\n".join(lines))
            for why, glyphs in hidden_runs.items():
                text = "".join(glyphs)
                dropped.append(Dropped(page=n, reason=why, text=text))
                if not scanned and PAYMENT_WORDS.search(text):
                    held.add("hidden_text")
    if n == 0:
        raise ValueError("PDF has no pages")
    return Intake(
        sha256=digest,
        pages=n,
        visible_text="\n\f\n".join(visible_pages),
        dropped=dropped,
        held=sorted(held),
    )
