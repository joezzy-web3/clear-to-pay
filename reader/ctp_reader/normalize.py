"""Unicode clean-up before anything is read or compared.

Invoices arrive in many languages, and Unicode has many ways to make two strings
look the same while being different, or to make text display in a different order
from how it is stored. Every visible string goes through here first:

- zero-width characters and bidirectional controls are removed and reported
  (an invoice that contains them is HELD: they have no business on an invoice);
- NFKC normalisation folds compatibility forms (fullwidth letters, ligatures);
- every decimal digit from any script becomes 0-9 (Arabic-Indic, Devanagari, ...);
- tokens that mix Latin, Cyrillic or Greek letters are flagged (a Cyrillic "і" in
  "Qіngmar" makes a different supplier that looks identical);
- Chinese financial numerals (壹贰叁...) are parsed so the amount in words can be
  checked against the figures.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from decimal import Decimal

ZERO_WIDTH = {"​", "‌", "‍", "⁠", "﻿", "­", "᠎"}
BIDI_CONTROLS = {
    "‎", "‏", "؜",
    "‪", "‫", "‬", "‭", "‮",
    "⁦", "⁧", "⁨", "⁩",
}  # fmt: skip
CONFUSABLE_SCRIPTS = ("LATIN", "CYRILLIC", "GREEK", "ARMENIAN", "CHEROKEE")


@dataclass
class Clean:
    text: str
    held: list[str] = field(default_factory=list)
    mixed_script_tokens: list[str] = field(default_factory=list)


def _script(ch: str) -> str | None:
    if not ch.isalpha():
        return None
    name = unicodedata.name(ch, "")
    for s in CONFUSABLE_SCRIPTS:
        if name.startswith(s):
            return s
    return None


def clean(text: str) -> Clean:
    held: set[str] = set()
    out = []
    for ch in text:
        if ch in ZERO_WIDTH:
            held.add("zero_width")
            continue
        if ch in BIDI_CONTROLS:
            held.add("bidi_control")
            continue
        out.append(ch)
    s = unicodedata.normalize("NFKC", "".join(out))
    s = "".join(
        str(unicodedata.decimal(c)) if unicodedata.category(c) == "Nd" and not c.isascii() else c
        for c in s
    )
    mixed = []
    for token in re.findall(r"\w+", s):
        scripts = {sc for c in token if (sc := _script(c))}
        if len(scripts) > 1:
            mixed.append(token)
    if mixed:
        held.add("mixed_script")
    return Clean(text=s, held=sorted(held), mixed_script_tokens=mixed)


# ------------------------------------------------------------------ Chinese amounts in words

_DIGITS = {"零": 0, "〇": 0, "壹": 1, "贰": 2, "貳": 2, "叁": 3, "參": 3, "肆": 4, "伍": 5,
           "陆": 6, "陸": 6, "柒": 7, "捌": 8, "玖": 9,
           "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}  # fmt: skip
_SMALL = {"拾": 10, "十": 10, "佰": 100, "百": 100, "仟": 1000, "千": 1000}
_BIG = {"万": 10_000, "萬": 10_000, "亿": 100_000_000, "億": 100_000_000}


def _section(tokens: str, *, leading: bool) -> int:
    """A number below 10,000 written as digit+unit pairs, strictly descending
    (仟 > 佰 > 拾 > units), with 零 marking skipped places. Anything else is refused,
    never guessed: 壹拾拾, 拾佰, 壹贰, 贰佰伍 (colloquial 250) all raise."""
    value, last_unit, i = 0, 10_000, 0
    zero_pending = False
    while i < len(tokens):
        ch = tokens[i]
        if ch in ("零", "〇"):
            if zero_pending or i == 0 or i == len(tokens) - 1:
                raise ValueError("misplaced 零")
            zero_pending = True
            i += 1
            continue
        if ch in _SMALL:
            # A bare 拾 is allowed only at the very start of the whole amount (拾元 = 10).
            if not (leading and i == 0 and _SMALL[ch] == 10):
                raise ValueError(f"unit {ch!r} without a digit")
            digit, unit = 1, 10
            i += 1
        elif ch in _DIGITS:
            digit = _DIGITS[ch]
            if digit == 0:
                raise ValueError("misplaced zero digit")
            nxt = tokens[i + 1] if i + 1 < len(tokens) else None
            if nxt in _SMALL:
                unit = _SMALL[nxt]
                i += 2
            elif nxt is None:
                unit = 1
                i += 1
            else:
                raise ValueError("two digits in a row")
        else:
            raise ValueError(f"not a Chinese numeral: {ch!r}")
        if unit >= last_unit:
            raise ValueError("units out of order or repeated")
        # A skipped place must be marked with 零 (贰佰伍 is ambiguous; 贰佰零伍 = 205).
        if not zero_pending and last_unit != 10_000 and unit * 10 != last_unit:
            raise ValueError("skipped place without 零")
        if zero_pending and unit * 10 == last_unit:
            raise ValueError("零 where no place is skipped")
        zero_pending = False
        value += digit * unit
        last_unit = unit
    return value


def _integer(words: str) -> int:
    """Whole amount: sections joined by 亿 then 万, each below 10,000."""
    total, rest, first = 0, words, True
    for big_char, big in (("亿", 100_000_000), ("万", 10_000)):
        alt = {"亿": "億", "万": "萬"}[big_char]
        parts = re.split(f"[{big_char}{alt}]", rest)
        if len(parts) > 2:
            raise ValueError(f"{big_char} repeated")
        if len(parts) == 2:
            head, rest = parts
            if not head:
                raise ValueError(f"{big_char} without a number")
            total += _section(head, leading=first) * big
            first = False
            zero = rest.startswith("零")
            rest = rest[1:] if zero else rest
            # 壹万伍 is colloquial for 15,000; a written amount says 壹万零伍 (10,005).
            # So a lower section must start at 仟 unless 零 marks the gap.
            if rest and not zero and rest[1:2] not in ("仟", "千"):
                raise ValueError(f"place skipped after {big_char} without 零")
            if zero and rest[1:2] in ("仟", "千"):
                raise ValueError(f"零 after {big_char} where no place is skipped")
    if rest:
        total += _section(rest, leading=first)
    return total


def chinese_amount(words: str) -> Decimal:
    """Parse e.g. 柒元捌角 (7.80) or 壹拾贰元整 (12.00). Raises ValueError if unsure."""
    w = re.sub(r"[\s(（]*(人民币|RMB|美元|USD|USDC)[)）]*", "", words).rstrip("整正")
    m = re.fullmatch(r"(?:(.+?)[元圆])?(?:零(?=.分$))?(?:(.)角)?(?:(.)分)?", w)
    if not m or not w:
        raise ValueError("cannot read amount in words")
    yuan, jiao, fen = m.groups()
    if yuan in ("零", "〇"):
        yuan = None
    value = Decimal(_integer(yuan)) if yuan else Decimal(0)
    if jiao:
        value += Decimal(_DIGITS[jiao]) / 10
    if fen:
        value += Decimal(_DIGITS[fen]) / 100
    return value
