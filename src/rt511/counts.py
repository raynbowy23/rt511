"""Published traffic counts, joined to a region's cameras.

Attention needs an absolute sense of how big a road is, otherwise a rural lane having an unusual minute outranks an interstate. Road capacity and class from OpenStreetMap are a proxy; a published annual average daily traffic count is the real thing. Where a source's agency publishes its counts as an open segment layer under terms that allow it, `data/sources.json` names the layer under the source's `counts`, and this joins it to the cameras.

A one-off enrichment, not live data. It writes `data/aadt_<region>.json`, which the server reads, and it needs the region's graph built first, because a count is only believed when its segment runs along the carriageway the camera was snapped to."""

import json
import math
from dataclasses import dataclass
from pathlib import Path

import httpx
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

from .catalog import catalog_path, load_catalog
from .geo import LocalFrame, bearing_diff
from .graph import graph_path
from .refs import ref_tokens
from .regions import Region, data_dir
from .sources import USER_AGENT, Source, get_source

PAGE = 2000
"""Records per query. Both layers wired up publish a maximum of 2,000."""
MATCH_MAX_M = 150.0
"""How far a camera may sit from a counted segment and still be counted as on it. Generous because the published geometry is a centerline and cameras stand beside the road, sometimes on a bridge above it."""
SAME_ROAD_DEG = 40.0
"""How closely a counted segment must lie along the carriageway a camera was snapped to before they are believed to be the same road. Without this an interstate camera at an interchange takes the count of the local road crossing beneath it: in the first state this was built for, a camera on an interstate came back at 1,800 vehicles a day, the side road's figure, against the interstate's 43,000.

Compared as an axis rather than a direction. The published geometry is an undirected centerline, so the same road appears at 290 degrees or 110 depending on which end it was drawn from, and treating those as different roads rejects the correct match every other time."""


def _axis_offset(a: float, b: float) -> float:
    """How far two headings differ once direction is ignored, so a road and the same road drawn backwards agree."""
    d = bearing_diff(a, b)
    return min(d, 180.0 - d)


@dataclass
class Segment:
    aadt: int
    year: int | None
    roadway: str
    county: str | None
    truck_pct: float | None
    coords: list[tuple[float, float]]


def has_counts(source: Source) -> bool:
    return bool(source.counts)


def fetch_segments(region: Region, source: Source) -> list[Segment]:
    """Every counted segment intersecting the region, paged out of the source's count layer."""
    counts = source.counts
    fields: dict[str, str] = counts["fields"]
    s, w, n, e = region.bbox
    out: list[Segment] = []
    offset = 0
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=90.0, follow_redirects=True) as http:
        while True:
            r = http.get(
                f"{counts['layer']}/query",
                params={
                    # KYTC publishes ramps as sections of the route they serve; a `where` in the source table keeps mainline sections only.
                    "where": counts.get("where", "1=1"),
                    "geometry": f"{w},{s},{e},{n}",
                    "geometryType": "esriGeometryEnvelope",
                    "inSR": "4326",
                    "outSR": "4326",
                    "spatialRel": "esriSpatialRelIntersects",
                    "outFields": ",".join(sorted(set(fields.values()))),
                    "returnGeometry": "true",
                    "resultOffset": str(offset),
                    "resultRecordCount": str(PAGE),
                    "f": "json",
                },
            )
            r.raise_for_status()
            page = r.json()
            if "error" in page:
                raise SystemExit(f"{source.key} counts: {page['error']}")
            feats = page.get("features") or []
            for f in feats:
                a = f.get("attributes") or {}
                aadt = a.get(fields["aadt"])
                paths = (f.get("geometry") or {}).get("paths") or []
                if not paths or not aadt:
                    continue
                label = str(a.get(fields["roadway"]) or "") if "roadway" in fields else ""
                # Iowa names a ramp after the routes it joins ("86TH ST, N TO I 35 S"), so it carries the interstate's route and a ramp's count. The source table names the pattern that marks one.
                if counts.get("exclude_roadway") and counts["exclude_roadway"] in label.upper():
                    continue
                trucks = a.get(fields["trucks"]) if "trucks" in fields else None
                # A route is either named in one field, or split into a prefix and a number the way KYTC publishes it ("I" and 65).
                roadway = str(a.get(fields["roadway"]) or "").strip() if "roadway" in fields else f"{a.get(fields.get('route_prefix', ''), '') or ''} {a.get(fields.get('route_number', ''), '') or ''}".strip()
                year = a.get(fields["year"]) if "year" in fields else None
                for path in paths:
                    if len(path) >= 2:
                        out.append(
                            Segment(
                                aadt=int(aadt),
                                year=int(year) if year else None,
                                roadway=roadway,
                                county=str(a.get(fields["county"])).strip() if "county" in fields and a.get(fields["county"]) else None,
                                truck_pct=round(100.0 * float(trucks) / float(aadt), 1) if trucks else None,
                                coords=[(float(x), float(y)) for x, y in path],
                            )
                        )
            if not page.get("exceededTransferLimit") or not feats:
                break
            offset += len(feats)
    return out


def _camera_bearings(root: Path, region: Region) -> dict[int, float]:
    """The bearing of the carriageway each camera was snapped to, from the graph."""
    graph = json.loads(graph_path(root, region).read_text())
    out: dict[int, float] = {}
    for site in graph["sites"]:
        snap = (site.get("snaps") or [None])[0]
        if snap is None or snap.get("bearing") is None:
            continue
        for native in site["cameras"]:
            out[int(native)] = float(snap["bearing"])
    return out


def _segment_bearing(line: LineString, p: Point) -> float:
    """Direction of the counted segment where it passes closest to the camera."""
    t = line.project(p)
    a = line.interpolate(max(0.0, t - 25.0))
    b = line.interpolate(min(line.length, t + 25.0))
    return (math.degrees(math.atan2(b.x - a.x, b.y - a.y)) + 360) % 360


def match_cameras(region: Region, root: Path) -> dict:
    """Nearest counted segment for each camera, preferring one that runs the same way as the road the camera watches."""
    source = get_source(region.source)
    if not has_counts(source):
        raise SystemExit(f"{source.name} publishes no traffic-count layer this project has joined. Cameras there use road capacity or class instead.")
    if not graph_path(root, region).exists():
        raise SystemExit(f"build the graph first: uv run rt511 build --region {region.key}")
    cams = load_catalog(catalog_path(root, region))
    segs = fetch_segments(region, source)
    matched: dict[str, dict] = {}
    if segs:
        frame = LocalFrame(*region.centroid)
        lines = [LineString([frame.to_xy(lat, lon) for lon, lat in s.coords]) for s in segs]
        tree = STRtree(lines)
        bearings = _camera_bearings(root, region)
        routes = [ref_tokens(s.roadway) for s in segs]
        for c in cams:
            p = Point(*frame.to_xy(c.lat, c.lon))
            want = bearings.get(c.id)
            refs = c.refs
            aligned: list[tuple[float, int]] = []
            any_near: list[tuple[float, int]] = []
            for i in map(int, tree.query(p.buffer(MATCH_MAX_M))):
                d = p.distance(lines[i])
                if d > MATCH_MAX_M:
                    continue
                # A camera that names its route takes a count only from a segment on that route. At an interchange a ramp or a crossing road runs close and nearly parallel, and taking its count put an interstate camera at 1,760 vehicles a day; with no segment on the right route in range, the camera keeps its capacity prior instead.
                if refs and not (refs & routes[i]):
                    continue
                any_near.append((d, i))
                if want is None or _axis_offset(_segment_bearing(lines[i], p), want) <= SAME_ROAD_DEG:
                    aligned.append((d, i))
            # A segment running the same way as the camera's road wins, even when a crossing road passes closer.
            pool = aligned or any_near
            if not pool:
                continue
            d, i = min(pool)
            s = segs[i]
            matched[str(c.id)] = {"aadt": s.aadt, "year": s.year, "county": s.county, "truck_pct": s.truck_pct, "distance_m": round(d, 1), "aligned": bool(aligned)}
    return {
        "region": region.key,
        "source": source.key,
        "attribution": source.counts["attribution"],
        "terms_url": source.counts.get("terms_url", ""),
        "segments": len(segs),
        "cameras": matched,
    }


def aadt_path(root: Path, region: Region) -> Path:
    return data_dir(root, region) / f"aadt_{region.key}.json"


def write_aadt(data: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1))
