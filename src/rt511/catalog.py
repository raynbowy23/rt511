"""The camera catalog for a region: read from its agency's published feed, cut to the region, cached as JSON under data/, and loaded back as Camera records.

Everything state-specific is optional, because the feeds disagree on what they publish: Caltrans carries a direction and a milepost, Iowa a route and a linear reference, others little more than a description."""

import json
from dataclasses import asdict, dataclass
from pathlib import Path

import httpx

from .feeds import feed_cameras
from .refs import ref_tokens
from .regions import Region, data_dir, distance_km
from .sources import USER_AGENT, Source, get_source


@dataclass
class Camera:
    id: int
    region: str
    source: str
    image_path: str
    roadway: str
    direction: str | None
    location: str
    lat: float
    lon: float
    video_url: str | None
    video_auth: bool
    link_id: str | None
    source_system: str
    mile_marker: float | None

    @property
    def at_intersection(self) -> bool:
        """True when the location joins two roads with an ampersand, which marks a signalized junction. Interchanges are written as "US 12/18 at Whitney Way" instead, so the ampersand stays a reliable marker."""
        return " & " in self.location

    @property
    def refs(self) -> frozenset[str]:
        """Route tokens used to pull this camera onto the right carriageway, taken from the roadway field only. Intersection cameras get none: a camera at a ramp terminal can carry roadway "I-10 South", meaning the approach leg, and matching that to I-10 would snap it onto the mainline."""
        if self.at_intersection:
            return frozenset()
        return ref_tokens(self.roadway)

    def to_dict(self) -> dict:
        return asdict(self)


def plausible(lat: float, lon: float) -> bool:
    """Reject coordinates that cannot be a camera in the United States. Some feeds carry entries at 0,0 or with the longitude sign flipped, which would otherwise drag a bounding box across the Atlantic."""
    return -170.0 < lon < -60.0 and 18.0 < lat < 72.0


def _nearest(region: Region, points: list, lat_of, lon_of) -> list:
    inside = [p for p in points if plausible(lat_of(p), lon_of(p)) and region.contains(lat_of(p), lon_of(p))]
    if region.center:
        inside.sort(key=lambda p: distance_km(region.center[0], region.center[1], lat_of(p), lon_of(p)))
    return inside[: region.limit] if region.limit else inside


async def _fetch_feed_catalog(region: Region, source: Source) -> list[Camera]:
    """A region's cameras from its agency's published feed. The feed is read whole, because none of them can be asked for a bounding box, and then cut to the region: inside its box, nearest the center first, up to its limit."""
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=60.0, follow_redirects=True) as http:
        cams = await feed_cameras(http, source)
    kept = _nearest(region, cams, lambda c: c.lat, lambda c: c.lon)
    return sorted(
        (
            Camera(
                id=c.id,
                region=region.key,
                source=source.key,
                image_path=c.image_url,
                roadway=c.roadway,
                direction=c.direction,
                location=c.location,
                lat=c.lat,
                lon=c.lon,
                video_url=c.video_url,
                video_auth=False,
                link_id=None,
                source_system=c.system,
                mile_marker=c.mile_marker,
            )
            for c in kept
        ),
        key=lambda c: c.id,
    )


async def fetch_catalog(region: Region) -> list[Camera]:
    return await _fetch_feed_catalog(region, get_source(region.source))


def catalog_path(root: Path, region: Region) -> Path:
    return data_dir(root, region) / f"cameras_{region.key}.json"


def write_catalog(cams: list[Camera], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([c.to_dict() for c in cams], indent=1))


def load_catalog(path: Path) -> list[Camera]:
    return [Camera(**rec) for rec in json.loads(Path(path).read_text())]
