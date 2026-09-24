"""A region is the unit this project works in: a patch of one 511 site's coverage, small enough that the camera graph stays comprehensible and the polling load stays polite.

Regions are created from a city name rather than hand-written coordinates, because with thousands of cameras available across several states, naming a place is the only sane way to choose a slice. Created regions persist in `data/regions.json`."""

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

from .geocode import geocode
from .sources import source_for_state

OVERPASS_CLASSES = "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified"
KM_PER_DEG_LAT = 110.574


@dataclass(frozen=True)
class Region:
    key: str
    name: str
    source: str
    bbox: tuple[float, float, float, float]
    """south, west, north, east"""
    center: tuple[float, float] | None = None
    radius_km: float | None = None
    limit: int | None = None
    """Cap on cameras kept, nearest to the centre first. With twenty thousand cameras on offer, a wall wants the dozens nearest a place, not everything in range."""

    @property
    def centroid(self) -> tuple[float, float]:
        """The centre to draw this region at. Regions created from a city carry a real centre; the two hand-written ones do not, so fall back to the middle of the bounding box rather than making every caller re-derive it."""
        if self.center:
            return self.center
        s, w, n, e = self.bbox
        return (round((s + n) / 2, 6), round((w + e) / 2, 6))

    @property
    def overpass_query(self) -> str:
        s, w, n, e = self.bbox
        return f'[out:json][timeout:120];\n(\n  way["highway"~"^({OVERPASS_CLASSES})$"]({s},{w},{n},{e});\n);\nout body geom;\n'

    def contains(self, lat: float, lon: float) -> bool:
        s, w, n, e = self.bbox
        if not (s <= lat <= n and w <= lon <= e):
            return False
        if self.center and self.radius_km:
            return distance_km(self.center[0], self.center[1], lat, lon) <= self.radius_km
        return True

    def to_dict(self) -> dict:
        return asdict(self)


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(a))


def bbox_around(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    dlat = radius_km / KM_PER_DEG_LAT
    dlon = radius_km / (KM_PER_DEG_LAT * max(math.cos(math.radians(lat)), 0.01))
    return (round(lat - dlat, 4), round(lon - dlon, 4), round(lat + dlat, 4), round(lon + dlon, 4))


def slugify(name: str) -> str:
    out = "".join(c.lower() if c.isalnum() else "-" for c in name)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


BUILTIN: dict[str, Region] = {}
"""Every region now comes from `data/regions.json`. The two hand-written ones this project started with were on sources it no longer reads."""


def _store(root: Path) -> Path:
    return root / "data" / "regions.json"


def load_regions(root: Path) -> dict[str, Region]:
    regions = dict(BUILTIN)
    path = _store(root)
    if path.exists():
        for rec in json.loads(path.read_text()):
            rec["bbox"] = tuple(rec["bbox"])
            if rec.get("center"):
                rec["center"] = tuple(rec["center"])
            regions[rec["key"]] = Region(**rec)
    return regions


def save_region(region: Region, root: Path) -> None:
    path = _store(root)
    existing = [r for r in (json.loads(path.read_text()) if path.exists() else []) if r["key"] != region.key]
    existing.append(region.to_dict())
    existing.sort(key=lambda r: r["key"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(existing, indent=1))


def region_for_city(query: str, root: Path, radius_km: float = 15.0, limit: int | None = None) -> Region:
    """Geocode a city, pick the 511 site covering its state, and build a region around it."""
    place = geocode(query, root)
    if place is None:
        raise SystemExit(f"could not geocode {query!r} to a place in the United States")
    source = source_for_state(place.state)
    if source is None:
        raise SystemExit(f"{place.name} is in {place.state}, which has no camera source this project reads. Run `rt511 sources` to see what is covered.")
    return Region(
        key=slugify(place.name),
        name=place.name,
        source=source.key,
        bbox=bbox_around(place.lat, place.lon, radius_km),
        center=(round(place.lat, 6), round(place.lon, 6)),
        radius_km=radius_km,
        limit=limit,
    )


def get_region(key: str, root: Path) -> Region:
    regions = load_regions(root)
    try:
        return regions[key]
    except KeyError:
        raise SystemExit(f'unknown region {key!r}. Known: {", ".join(sorted(regions))}. Add one with `rt511 city "<city>, <state>"`.') from None
