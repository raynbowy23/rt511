"""Snap cameras onto the road network, cluster co-located cameras into sites, and splice the sites into the directed road graph so that shortest paths must pass through them.

Snapping is scored rather than nearest-wins. A camera's route number, when it has one, is the strongest signal available: it is what separates a mainline camera from the frontage road twenty meters away, and unlike a mile marker every state publishes it. Direction codes break the remaining tie between the two carriageways of a divided road."""

from collections import defaultdict
from dataclasses import dataclass, field
from itertools import pairwise

import networkx as nx
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

from .catalog import Camera
from .geo import LocalFrame, bearing_deg, bearing_diff, direction_offset, haversine_m
from .osm import SegmentKey
from .refs import ref_tokens

SNAP_MAX_M = 80.0
SITE_MERGE_M = 40.0
SAME_CARRIAGEWAY_DEG = 45.0
REF_MATCH_BONUS = 60.0
REF_CONFLICT_PENALTY = 40.0
REF_MISSING_PENALTY = 10.0
DIRECTION_PENALTY = 50.0
MAINLINE_PENALTY = 80.0
MIRROR_MAX_M = 90.0
OPPOSITE_DEG = 135.0


@dataclass
class Snap:
    seg: SegmentKey
    a: int
    b: int
    t: float
    lat: float
    lon: float
    bearing: float
    two_way: bool
    distance_m: float
    highway: str | None
    name: str | None
    ref: str | None
    lanes: int | None
    lanes_forward: int | None
    lanes_backward: int | None
    maxspeed_kmh: float
    maxspeed_source: str

    @property
    def is_mainline(self) -> bool:
        """True on a motorway carriageway. Ramps and links are excluded: a camera on a ramp belongs to the interchange, not to the corridor."""
        return self.highway == "motorway"


@dataclass
class Site:
    id: str
    cameras: list[Camera]
    snaps: list[Snap]

    @property
    def refs(self) -> frozenset[str]:
        """Route tokens of the carriageways this site sits on, taken from the road rather than the camera name."""
        out: frozenset[str] = frozenset()
        for s in self.snaps:
            out |= ref_tokens(s.ref)
        return out

    lat: float = 0.0
    lon: float = 0.0
    is_freeway: bool = False
    roadway: str = ""
    mile_marker: float | None = None
    bearing: float | None = None
    meta: dict = field(default_factory=dict)


class Snapper:
    def __init__(self, road: nx.DiGraph):
        self.road = road
        lats = [d["lat"] for _, d in road.nodes(data=True)]
        lons = [d["lon"] for _, d in road.nodes(data=True)]
        self.frame = LocalFrame(sum(lats) / len(lats), sum(lons) / len(lons))
        self.segments: list[tuple[SegmentKey, int, int]] = []
        seen: set[SegmentKey] = set()
        lines = []
        for a, b, d in road.edges(data=True):
            key = d["seg"]
            if key in seen:
                continue
            seen.add(key)
            # Keep the way's forward orientation so t measures from the forward start.
            if road.has_edge(b, a) and not road.has_edge(a, b):
                a, b = b, a
            pa, pb = road.nodes[a], road.nodes[b]
            lines.append(LineString([self.frame.to_xy(pa["lat"], pa["lon"]), self.frame.to_xy(pb["lat"], pb["lon"])]))
            self.segments.append((key, a, b))
        self.lines = lines
        self.tree = STRtree(lines)

    def snap(self, lat: float, lon: float, refs: frozenset[str] = frozenset(), direction: str | None = None, avoid_mainline: bool = False) -> Snap | None:
        """Best segment for a camera within SNAP_MAX_M, scored rather than nearest-wins. `avoid_mainline` is for cameras known to sit at a signalised intersection, which a motorway carriageway can otherwise win by a few meters where it passes overhead."""
        p = Point(*self.frame.to_xy(lat, lon))
        best: tuple[float, int] | None = None
        for i in map(int, self.tree.query(p.buffer(SNAP_MAX_M))):
            line = self.lines[i]
            dist = p.distance(line)
            if dist > SNAP_MAX_M:
                continue
            key, a, b = self.segments[i]
            d = self.road.get_edge_data(a, b) or self.road.get_edge_data(b, a)
            score = dist
            if refs:
                seg_refs = ref_tokens(d.get("ref"))
                if seg_refs & refs:
                    score -= REF_MATCH_BONUS
                elif seg_refs:
                    score += REF_CONFLICT_PENALTY
                else:
                    score += REF_MISSING_PENALTY
            if avoid_mainline and d.get("highway") == "motorway":
                score += MAINLINE_PENALTY
            if direction:
                pa, pb = self.road.nodes[a], self.road.nodes[b]
                one_way = not (self.road.has_edge(a, b) and self.road.has_edge(b, a))
                off = direction_offset(bearing_deg(pa["lat"], pa["lon"], pb["lat"], pb["lon"]), direction) if one_way else None
                if off is not None:
                    # Graded rather than pass/fail. Between the two carriageways of a divided road the better-aligned one wins even where the route curves away from its signed direction, which a hard compass test gets wrong.
                    score += DIRECTION_PENALTY * (off / 180.0)
            if best is None or score < best[0]:
                best = (score, i)
        if best is None:
            return None
        i = best[1]
        line = self.lines[i]
        key, a, b = self.segments[i]
        t = line.project(p)
        q = line.interpolate(t)
        qlat, qlon = self.frame.to_latlon(q.x, q.y)
        pa, pb = self.road.nodes[a], self.road.nodes[b]
        d = self.road.get_edge_data(a, b) or self.road.get_edge_data(b, a)
        return Snap(
            seg=key,
            a=a,
            b=b,
            t=t,
            lat=qlat,
            lon=qlon,
            bearing=bearing_deg(pa["lat"], pa["lon"], pb["lat"], pb["lon"]),
            two_way=self.road.has_edge(a, b) and self.road.has_edge(b, a),
            lanes=d.get("lanes"),
            lanes_forward=d.get("lanes_forward"),
            lanes_backward=d.get("lanes_backward"),
            maxspeed_kmh=d["maxspeed_kmh"],
            maxspeed_source=d["maxspeed_source"],
            distance_m=p.distance(line),
            highway=d.get("highway"),
            name=d.get("name"),
            ref=d.get("ref"),
        )

    def mirror(self, snap: Snap) -> Snap | None:
        """The opposing carriageway of the same divided road, if there is one within MIRROR_MAX_M.

        This exists for sources that publish no direction code. A camera on a divided freeway then lands on whichever carriageway happens to be nearer, and two consecutive cameras can end up on opposite sides, which leaves no directed path between them and fragments the corridor. When we cannot know which way a camera looks, the honest model is that its site spans the whole cross-section, so the site gets a hub on both carriageways."""
        if snap.two_way:
            return None
        refs = ref_tokens(snap.ref)
        p = Point(*self.frame.to_xy(snap.lat, snap.lon))
        best: tuple[float, int] | None = None
        for i in map(int, self.tree.query(p.buffer(MIRROR_MAX_M))):
            key, a, b = self.segments[i]
            if key.way_id == snap.seg.way_id:
                continue
            d = self.road.get_edge_data(a, b) or self.road.get_edge_data(b, a)
            if d.get("highway") != snap.highway or self.road.has_edge(a, b) and self.road.has_edge(b, a):
                continue
            if refs and ref_tokens(d.get("ref")) != refs:
                continue
            pa, pb = self.road.nodes[a], self.road.nodes[b]
            if bearing_diff(bearing_deg(pa["lat"], pa["lon"], pb["lat"], pb["lon"]), snap.bearing) < OPPOSITE_DEG:
                continue
            dist = p.distance(self.lines[i])
            if dist <= MIRROR_MAX_M and (best is None or dist < best[0]):
                best = (dist, i)
        if best is None:
            return None
        return self.snap(*self.frame.to_latlon(*self.lines[best[1]].interpolate(self.lines[best[1]].project(p)).coords[0]))


def _compatible(s1: Snap, s2: Snap) -> bool:
    if s1.is_mainline != s2.is_mainline:
        return False
    if haversine_m(s1.lat, s1.lon, s2.lat, s2.lon) > SITE_MERGE_M:
        return False
    if s1.two_way or s2.two_way:
        return True
    return bearing_diff(s1.bearing, s2.bearing) < SAME_CARRIAGEWAY_DEG


def cluster_sites(cams: list[Camera], snaps: dict[int, Snap], prefix: str = "") -> list[Site]:
    """Union-find over cameras. Two cameras share a site when their snapped points are close and they sit on the same carriageway or on a two-way street, and never across the motorway/surface boundary.

    Site ids carry the region as a prefix so that graphs from different regions can be served together without colliding."""
    ids = [c.id for c in cams if c.id in snaps]
    parent = {i: i for i in ids}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    by_id = {c.id: c for c in cams}
    for i, a in enumerate(ids):
        for b in ids[i + 1 :]:
            if _compatible(snaps[a], snaps[b]):
                parent[find(a)] = find(b)
    groups: dict[int, list[int]] = defaultdict(list)
    for i in ids:
        groups[find(i)].append(i)
    sites = []
    for k, members in enumerate(sorted(groups.values(), key=lambda m: min(m))):
        ms = [by_id[i] for i in members]
        ss = [snaps[i] for i in members]
        site = Site(id=f"{prefix}S{k:03d}", cameras=ms, snaps=ss)
        site.lat = sum(c.lat for c in ms) / len(ms)
        site.lon = sum(c.lon for c in ms) / len(ms)
        site.is_freeway = ss[0].is_mainline
        roadways: dict[str, int] = defaultdict(int)
        for c in ms:
            roadways[c.roadway] += 1
        site.roadway = max(roadways, key=roadways.get)
        mms = [c.mile_marker for c in ms if c.mile_marker is not None]
        site.mile_marker = sum(mms) / len(mms) if mms else None
        oneway = [s.bearing for s in ss if not s.two_way]
        site.bearing = oneway[0] if oneway else None
        sites.append(site)
    return sites


def splice_sites(road: nx.DiGraph, sites: list[Site]) -> nx.DiGraph:
    """Return a copy of the road graph with one hub node per site, spliced into every segment a member camera snapped to. Original segment edges are replaced by chains through the hubs, so any path along that carriageway must visit the hub."""
    g = road.copy()
    inserts: dict[SegmentKey, list[tuple[float, str]]] = defaultdict(list)
    seg_ends: dict[SegmentKey, tuple[int, int]] = {}
    for site in sites:
        node = f"site:{site.id}"
        g.add_node(node, lat=site.lat, lon=site.lon, site=site.id)
        for s in site.snaps:
            seg_ends[s.seg] = (s.a, s.b)
            if all(abs(t - s.t) > 0.5 or n != node for t, n in inserts[s.seg]):
                inserts[s.seg].append((s.t, node))
    for key, points in inserts.items():
        a, b = seg_ends[key]
        fwd = g.get_edge_data(a, b)
        rev = g.get_edge_data(b, a)
        attrs = dict(fwd or rev)
        total = attrs["length_m"]
        speed = total / attrs["tt_s"] if attrs["tt_s"] else 1.0
        chain = [(0.0, a)] + sorted(points) + [(total, b)]
        if fwd is not None:
            g.remove_edge(a, b)
        if rev is not None:
            g.remove_edge(b, a)
        for (t1, n1), (t2, n2) in pairwise(chain):
            if n1 == n2:
                continue
            piece = {**attrs, "length_m": max(t2 - t1, 0.01), "tt_s": max(t2 - t1, 0.01) / speed}
            if fwd is not None:
                g.add_edge(n1, n2, **piece)
            if rev is not None:
                g.add_edge(n2, n1, **piece)
    return g


def add_mirrors(snapper: Snapper, sites: list[Site]) -> int:
    """Give every mainline site whose cameras carry no direction code a hub on the opposing carriageway too. Returns how many sites gained one."""
    n = 0
    for site in sites:
        if not site.is_freeway or any(c.direction for c in site.cameras):
            continue
        m = snapper.mirror(site.snaps[0])
        if m is not None and m.is_mainline:
            site.snaps.append(m)
            n += 1
    return n
