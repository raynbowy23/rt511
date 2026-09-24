"""Turn a city name into a point and a state, using OpenStreetMap's Nominatim.

Nominatim is volunteer-run and its usage policy is strict: identify yourself, stay at or under one request a second, and cache what you get back. This project geocodes once per region a person creates by hand and caches the answer under `data/`, which is about as light as a caller can be."""

import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .sources import USER_AGENT

NOMINATIM = "https://nominatim.openstreetmap.org/search"
MIN_INTERVAL_S = 1.1
_last_call = 0.0

STATE_ABBR = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO",
    "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
    "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA",
    "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN",
    "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
    "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA",
    "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", "tennessee": "TN", "texas": "TX",
    "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
}


@dataclass
class Place:
    query: str
    name: str
    state: str
    lat: float
    lon: float


def _cache(root: Path) -> Path:
    return root / "data" / "geocode.json"


def geocode(query: str, root: Path) -> Place | None:
    """One cached Nominatim lookup. Returns None when nothing matches or the match is outside the United States."""
    global _last_call
    path = _cache(root)
    store = json.loads(path.read_text()) if path.exists() else {}
    key = query.strip().lower()
    if key in store:
        return Place(**store[key]) if store[key] else None

    wait = MIN_INTERVAL_S - (time.time() - _last_call)
    if wait > 0:
        time.sleep(wait)
    params = urllib.parse.urlencode({"q": query, "format": "jsonv2", "addressdetails": 1, "limit": 5, "countrycodes": "us"})
    req = urllib.request.Request(f"{NOMINATIM}?{params}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        results = json.loads(r.read())
    _last_call = time.time()

    place = None
    for res in results:
        addr = res.get("address") or {}
        state = STATE_ABBR.get((addr.get("state") or "").lower())
        if not state:
            continue
        city = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("county") or res.get("name") or query
        place = Place(query=query, name=f"{city}, {state}", state=state, lat=float(res["lat"]), lon=float(res["lon"]))
        break

    store[key] = place.__dict__ if place else None
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(store, indent=1, sort_keys=True))
    return place
