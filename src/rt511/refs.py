"""Route number matching between 511 camera names and OpenStreetMap `ref` tags. This is what lets a camera find its own carriageway instead of a frontage road, and it works in any state, unlike mile markers, which few feeds carry.

A camera named "I-39/US 51 at County B" and an OSM way tagged `ref=I 39;US 51` both reduce to {I39, US51}. The slash form "US 12/18" means US 12 and US 18, so a bare number after a slash inherits the previous prefix."""

import re

STATE_PREFIXES = ("AK", "AZ", "CA", "CT", "FL", "GA", "IA", "ID", "KY", "LA", "ME", "NC", "NH", "NV", "NY", "OH", "OR", "PA", "RI", "UT", "VT", "WI", "WIS")
"""Abbreviations states use for their own routes, e.g. "NY 33", "WIS 30" or "OR 217". Route tokens are only read from a camera's roadway field and from OpenStreetMap `ref` tags, never from free text, which is what makes "OR" safe here. "IN" stays out until Indiana is a source."""

TOKEN_RE = re.compile(r"\b(I|IH|US|USH|SR|SH|STH|CR|CTH|" + "|".join(STATE_PREFIXES) + r")[\s-]*(\d+)((?:\s*/\s*\d+)*)", re.IGNORECASE)
PREFIX_ALIASES = {"IH": "I", "USH": "US", "STH": "SR", "SH": "SR", "CTH": "CR", **{p: "SR" for p in STATE_PREFIXES}}
"""State route prefixes all normalize to SR, because a camera name and an OSM tag rarely agree on the spelling, as in "WIS 30" against "WI 30"."""


def ref_tokens(text: str | None) -> frozenset[str]:
    """Normalized route tokens found in a camera name or an OSM ref tag."""
    if not text:
        return frozenset()
    out: set[str] = set()
    for prefix, number, extra in TOKEN_RE.findall(text.replace(";", " ")):
        p = PREFIX_ALIASES.get(prefix.upper(), prefix.upper())
        out.add(f"{p}{int(number)}")
        for more in re.findall(r"\d+", extra):
            out.add(f"{p}{int(more)}")
    return frozenset(out)
