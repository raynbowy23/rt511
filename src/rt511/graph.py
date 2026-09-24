"""Build the camera-site graph for a region: network adjacency between sites, edge classification, nearby pairs, validation, and JSON export."""

import json
import math
from collections import Counter
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path

import networkx as nx
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

from .catalog import Camera, catalog_path, load_catalog
from .geo import LocalFrame, bearing_diff, direction_offset, haversine_m
from .network import Site, Snap, Snapper, add_mirrors, cluster_sites, splice_sites
from .osm import build_road_graph, fetch_overpass
from .regions import Region
from .sources import get_source

ADJACENCY_CUTOFF_M = 8000.0
NEARBY_MAX_M = 150.0
MILE_M = 1609.344
PASSBY_M = 60.0
MAX_DETOUR_RATIO = 2.5
REVERSED_DEG = 135.0
"""Beyond this a camera's snapped carriageway runs against its signed direction, which means the wrong side of a divided road was chosen."""


@dataclass
class Edge:
    src: str
    dst: str
    kind: str
    length_m: float
    tt_s: float
    highways: list[str]
    geometry: list[tuple[float, float]]


@dataclass
class CameraGraph:
    region: Region
    cameras: list[Camera]
    sites: list[Site]
    edges: list[Edge]
    unsnapped: list[int]
    report: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        source = get_source(self.region.source)
        site_of = {c.id: s for s in self.sites for c in s.cameras}
        return {
            "meta": {
                "region": self.region.key,
                "region_name": self.region.name,
                "source": source.key,
                "source_name": source.name,
                "attribution": source.attribution,
                "bbox": list(self.region.bbox),
                "sites": len(self.sites),
                "cameras": len(self.cameras),
                "edges": len(self.edges),
                "unsnapped": self.unsnapped,
                "report": self.report,
            },
            "sites": [
                {
                    "id": s.id,
                    "lat": s.lat,
                    "lon": s.lon,
                    "is_freeway": s.is_freeway,
                    "roadway": s.roadway,
                    "mile_marker": s.mile_marker,
                    "bearing": s.bearing,
                    "cameras": [c.id for c in s.cameras],
                    "snaps": [{"lat": p.lat, "lon": p.lon, "highway": p.highway, "name": p.name, "ref": p.ref, "two_way": p.two_way, "lanes": p.lanes, "lanes_forward": p.lanes_forward, "lanes_backward": p.lanes_backward, "maxspeed_kmh": p.maxspeed_kmh, "maxspeed_source": p.maxspeed_source, "bearing": p.bearing, "distance_m": round(p.distance_m, 1)} for p in s.snaps],
                }
                for s in self.sites
            ],
            "cameras": [
                {
                    "id": c.id,
                    "region": c.region,
                    "source": c.source,
                    "roadway": c.roadway,
                    "direction": c.direction,
                    "location": c.location,
                    "lat": c.lat,
                    "lon": c.lon,
                    "mile_marker": c.mile_marker,
                    "site": site_of[c.id].id if c.id in site_of else None,
                    "is_freeway": site_of[c.id].is_freeway if c.id in site_of else False,
                    "has_video": bool(c.video_url),
                }
                for c in self.cameras
            ],
            "edges": [{"src": e.src, "dst": e.dst, "kind": e.kind, "length_m": round(e.length_m, 1), "tt_s": round(e.tt_s, 1), "highways": e.highways, "geometry": [[round(la, 6), round(lo, 6)] for la, lo in e.geometry]} for e in self.edges],
        }


def classify(src: Site, dst: Site, highways: list[str]) -> str | None:
    """Edge kind, or None for a relation that should not exist.

    Two mainline sites joined by a path that leaves the motorway are usually an exit-and-re-enter U-turn at an interchange, which is not a real corridor relation. They are a genuine movement when the two sites carry different route numbers, because then the ramps are a system interchange between two freeways, so that case becomes a ramp edge instead of being dropped."""
    hs = set(highways)
    if src.is_freeway and dst.is_freeway:
        if hs <= {"motorway"}:
            return "freeway"
        return "ramp" if src.refs and dst.refs and not (src.refs & dst.refs) else None
    if src.is_freeway != dst.is_freeway or "motorway_link" in hs:
        return "ramp"
    return "street"


def _passes_by(g: nx.DiGraph, path: list, coords: list, line: LineString, pt: Point, snap: Snap, site_is_freeway: bool) -> bool:
    """True when a site beside the path genuinely sits on the flow being traced. Two cases are exempt: a freeway camera beside a surface path or a surface camera beside a motorway path (grade separated, neither flow passes the other's camera) and a one-way carriageway whose bearing opposes the path (the other side of a divided road)."""
    t = line.project(pt)
    acc = 0.0
    seg = len(coords) - 2
    for i in range(len(coords) - 1):
        (x1, y1), (x2, y2) = coords[i], coords[i + 1]
        step = math.hypot(x2 - x1, y2 - y1)
        if acc + step >= t:
            seg = i
            break
        acc += step
    (x1, y1), (x2, y2) = coords[seg], coords[seg + 1]
    local_bearing = (math.degrees(math.atan2(x2 - x1, y2 - y1)) + 360) % 360
    highway = g.edges[path[seg], path[seg + 1]].get("highway")
    if (highway == "motorway") != site_is_freeway:
        return False
    if not snap.two_way and bearing_diff(snap.bearing, local_bearing) > 135:
        return False
    return True


def network_adjacency(g: nx.DiGraph, sites: list[Site], frame: LocalFrame) -> list[Edge]:
    """Directed site edges along traffic flow. Site t follows site s when the shortest path from s to t visits no other site hub, passes no other site's snapped point within PASSBY_M, and is not a long detour relative to the straight-line distance."""
    by_node = {f"site:{s.id}": s for s in sites}
    site_pts, site_ids, site_snaps, site_freeway = [], [], [], []
    for s in sites:
        for p in s.snaps:
            site_pts.append(Point(*frame.to_xy(p.lat, p.lon)))
            site_ids.append(s.id)
            site_snaps.append(p)
            site_freeway.append(s.is_freeway)
    pt_tree = STRtree(site_pts)
    edges = []
    for s in sites:
        src = f"site:{s.id}"
        dist, paths = nx.single_source_dijkstra(g, src, cutoff=ADJACENCY_CUTOFF_M, weight="length_m")
        for dst_node, path in paths.items():
            if dst_node == src or dst_node not in by_node:
                continue
            if any(n in by_node for n in path[1:-1]):
                continue
            t = by_node[dst_node]
            straight = haversine_m(s.lat, s.lon, t.lat, t.lon)
            if straight > 50 and dist[dst_node] / straight > MAX_DETOUR_RATIO:
                continue
            coords = [frame.to_xy(g.nodes[n]["lat"], g.nodes[n]["lon"]) for n in path]
            line = LineString(coords)
            blocked = False
            for i in pt_tree.query(line.buffer(PASSBY_M)):
                i = int(i)
                if site_ids[i] in (s.id, t.id):
                    continue
                if _passes_by(g, path, coords, line, site_pts[i], site_snaps[i], site_freeway[i]):
                    blocked = True
                    break
            if blocked:
                continue
            tt = 0.0
            highways: list[str] = []
            for u, v in pairwise(path):
                d = g.edges[u, v]
                tt += d["tt_s"]
                if d.get("highway") and (not highways or highways[-1] != d["highway"]):
                    highways.append(d["highway"])
            kind = classify(s, t, highways)
            if kind is None:
                continue
            geom = [(g.nodes[n]["lat"], g.nodes[n]["lon"]) for n in path]
            edges.append(Edge(s.id, t.id, kind, dist[dst_node], tt, highways, geom))
    return edges


def nearby_edges(sites: list[Site], adjacent: set[tuple[str, str]]) -> list[Edge]:
    """Undirected zero-length pairs for sites close enough to see the same place but with no traffic flow between them.

    In practice this is three situations at once, which is why the kind is named for the relation rather than for a road type: two surface cameras a block apart on parallel one-way streets, a freeway camera and the arterial camera at its interchange, and the two carriageways of a divided highway. What they share is only that you cannot drive from one to the other, so no corridor edge exists, yet looking at one you probably want the other."""
    out = []
    for i, a in enumerate(sites):
        for b in sites[i + 1 :]:
            if (a.id, b.id) in adjacent or (b.id, a.id) in adjacent:
                continue
            if haversine_m(a.lat, a.lon, b.lat, b.lon) <= NEARBY_MAX_M:
                out.append(Edge(a.id, b.id, "nearby", 0.0, 0.0, [], [(a.lat, a.lon), (b.lat, b.lon)]))
    return out


def validate(cams: list[Camera], sites: list[Site], edges: list[Edge], snaps: dict[int, Snap]) -> dict:
    """Checks that catch a bad snap. Both are optional by source: Wisconsin reports no direction code and no mile markers, so those sections come back empty rather than failing."""
    report: dict = {}
    # A direction code names the route's signed direction, not a compass heading, so only a near-reversal is evidence of a bad snap. Anything less is a road that curves away from the way it is signed, which is ordinary.
    mismatches = []
    offsets = []
    for c in cams:
        s = snaps.get(c.id)
        if not c.direction or s is None or s.two_way or not s.is_mainline:
            continue
        off = direction_offset(s.bearing, c.direction)
        if off is None:
            continue
        offsets.append(off)
        if off > REVERSED_DEG:
            mismatches.append({"camera": c.id, "location": c.location, "code": c.direction, "bearing": round(s.bearing), "off_by_deg": round(off)})
    report["direction_mismatches"] = mismatches
    if offsets:
        offsets.sort()
        report["direction_offset_deg"] = {"median": round(offsets[len(offsets) // 2]), "max": round(offsets[-1])}
    report["direction_checked"] = sum(1 for c in cams if c.direction and c.id in snaps and snaps[c.id].is_mainline and not snaps[c.id].two_way)
    by_id = {s.id: s for s in sites}
    mm_checks = []
    for e in edges:
        if e.kind != "freeway":
            continue
        a, b = by_id[e.src], by_id[e.dst]
        if a.mile_marker is None or b.mile_marker is None:
            continue
        expected = a.bearing if a.bearing is not None else 90.0
        dmm = b.mile_marker - a.mile_marker
        if not dmm:
            continue
        eastbound = bearing_diff(expected, 90.0) < 90.0
        ratio = e.length_m / (abs(dmm) * MILE_M)
        mm_checks.append({"edge": f"{e.src}->{e.dst}", "from_mm": a.mile_marker, "to_mm": b.mile_marker, "eastbound": eastbound, "order_ok": (dmm > 0) == eastbound, "length_ratio": round(ratio, 3)})
    report["freeway_mile_marker_checks"] = mm_checks
    report["freeway_order_violations"] = [m for m in mm_checks if not m["order_ok"]]
    report["freeway_length_outliers"] = [m for m in mm_checks if not 0.8 <= m["length_ratio"] <= 1.25]
    out_deg = Counter(e.src for e in edges if e.kind != "nearby")
    in_deg = Counter(e.dst for e in edges if e.kind != "nearby")
    report["isolated_sites"] = [s.id for s in sites if out_deg[s.id] == 0 and in_deg[s.id] == 0]
    report["edge_kinds"] = dict(Counter(e.kind for e in edges))
    report["site_sizes"] = dict(Counter(len(s.cameras) for s in sites))
    report["freeway_sites"] = sum(1 for s in sites if s.is_freeway)
    if snaps:
        report["snap_distance_m"] = {"max": round(max(s.distance_m for s in snaps.values()), 1), "mean": round(sum(s.distance_m for s in snaps.values()) / len(snaps), 1)}
        # A camera that names a route should land on a road carrying it. Three outcomes, not two: the road may carry no route number at all, which is the normal case for a ramp or a service road and is no evidence either way. Only a road that names a different route is a real miss, and even that has an honest false positive, a road carrying two designations where the state and OpenStreetMap disagree on which to publish. Nevada still signs I-515 where OpenStreetMap tags I 11.
        matched = unknown = mismatched = 0
        for c in cams:
            if not c.refs or c.id not in snaps:
                continue
            seg = _snap_refs(snaps[c.id])
            if not seg:
                unknown += 1
            elif c.refs & seg:
                matched += 1
            else:
                mismatched += 1
        report["ref_matched"] = matched
        report["ref_unnumbered_road"] = unknown
        report["ref_mismatched"] = mismatched
        report["ref_expected"] = matched + unknown + mismatched
    return report


def _snap_refs(s: Snap) -> frozenset[str]:
    from .refs import ref_tokens

    return ref_tokens(s.ref)


def build(region: Region, root: Path) -> CameraGraph:
    cams = load_catalog(catalog_path(root, region))
    osm_cache = root / "data" / f"osm_{region.key}.json"
    road = build_road_graph(fetch_overpass(region.overpass_query, osm_cache))
    snapper = Snapper(road)
    snaps: dict[int, Snap] = {}
    unsnapped: list[int] = []
    for c in cams:
        s = snapper.snap(c.lat, c.lon, c.refs, c.direction, avoid_mainline=c.at_intersection)
        if s is None:
            unsnapped.append(c.id)
        else:
            snaps[c.id] = s
    sites = cluster_sites(cams, snaps, prefix=f"{region.key}:")
    add_mirrors(snapper, sites)
    g = splice_sites(road, sites)
    edges = network_adjacency(g, sites, snapper.frame)
    adjacent = {(e.src, e.dst) for e in edges}
    edges += nearby_edges(sites, adjacent)
    report = validate(cams, sites, edges, snaps)
    report["road_graph"] = {"nodes": road.number_of_nodes(), "edges": road.number_of_edges()}
    return CameraGraph(region, cams, sites, edges, unsnapped, report)


def graph_path(root: Path, region: Region) -> Path:
    return root / "out" / f"graph_{region.key}.json"


def write_json(graph: CameraGraph, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(graph.to_json(), indent=1))
