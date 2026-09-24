"""Find where cameras actually cluster, so choosing a region is evidence rather than guesswork.

The national index has a position for every camera but no notion of place. Binning those positions and merging neighbouring bins into metro-sized groups answers the only question that matters when adding a region: where are there enough cameras to be worth watching."""

import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .index_national import load_index
from .regions import distance_km
from .sources import USER_AGENT

CELL_DEG = 0.20
"""About 20 km of latitude. Small enough to separate neighbouring metros, large enough that a corridor does not shatter into fragments."""
MERGE_KM = 30.0
MIN_CELL = 12


@dataclass
class Metro:
    cameras: int
    source: str
    lat: float
    lon: float
    name: str | None = None


def find_metros(root: Path, min_cameras: int = 40) -> list[Metro]:
    index = load_index(root)["sources"]
    cells: list[tuple[int, str, float, float]] = []
    for key, arr in index.items():
        grid: dict[tuple[int, int], list[tuple[float, float]]] = {}
        for lat, lon in zip(arr["lat"], arr["lon"]):
            grid.setdefault((round(lat / CELL_DEG), round(lon / CELL_DEG)), []).append((lat, lon))
        for pts in grid.values():
            if len(pts) >= MIN_CELL:
                cells.append((len(pts), key, sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)))

    metros: list[Metro] = []
    for n, key, lat, lon in sorted(cells, reverse=True):
        for m in metros:
            if m.source == key and distance_km(m.lat, m.lon, lat, lon) <= MERGE_KM:
                total = m.cameras + n
                m.lat = (m.lat * m.cameras + lat * n) / total
                m.lon = (m.lon * m.cameras + lon * n) / total
                m.cameras = total
                break
        else:
            metros.append(Metro(n, key, lat, lon))
    metros.sort(key=lambda m: -m.cameras)
    return [m for m in metros if m.cameras >= min_cameras]


def name_metros(metros: list[Metro]) -> None:
    """Reverse-geocode each centre through Nominatim, one a second as its usage policy requires. Optional, because the positions alone are enough to create a region."""
    for m in metros:
        params = urllib.parse.urlencode({"lat": round(m.lat, 4), "lon": round(m.lon, 4), "format": "jsonv2", "zoom": 10})
        req = urllib.request.Request(f"https://nominatim.openstreetmap.org/reverse?{params}", headers={"User-Agent": USER_AGENT})
        try:
            addr = json.load(urllib.request.urlopen(req, timeout=30)).get("address", {})
        except Exception:  # noqa: BLE001 - a missing name is cosmetic
            continue
        city = addr.get("city") or addr.get("town") or addr.get("county") or addr.get("municipality")
        state = (addr.get("ISO3166-2-lvl4") or "")[-2:]
        m.name = f"{city}, {state}" if city else None
        time.sleep(1.2)
