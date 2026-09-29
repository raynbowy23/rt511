"""Fetch and cache an Overpass extract of the major road network, and turn it into a directed networkx graph with lengths and free-flow travel times."""

import json
import math
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import networkx as nx

from .geo import haversine_m
from .sources import USER_AGENT

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Free-flow speed defaults in mph when OSM has no maxspeed tag.
DEFAULT_MPH = {
    "motorway": 70,
    "motorway_link": 45,
    "trunk": 55,
    "trunk_link": 35,
    "primary": 45,
    "primary_link": 35,
    "secondary": 35,
    "secondary_link": 30,
}
MPH_TO_MPS = 0.44704


@dataclass(frozen=True)
class SegmentKey:
    """Identifies one geometry segment of one way, in the way's drawing order."""

    way_id: int
    index: int


def fetch_overpass(query: str, cache_path: Path) -> dict:
    """Fetch the road extract for a region, or return the cached copy. Overpass is volunteer run, so this asks once per region and caches the answer under data/."""
    if cache_path.exists():
        return json.loads(cache_path.read_text())
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(OVERPASS_URL, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = resp.read()
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_bytes(payload)
    return json.loads(payload)


def speed_kmh(tags: dict) -> tuple[float, str]:
    ms = tags.get("maxspeed", "")
    parts = str(ms).lower().split()
    if parts and (len(parts) == 1 or len(parts) == 2 and parts[1] in ("mph", "km/h", "kmh", "kph")):
        try:
            value = float(parts[0])
            if math.isfinite(value) and value > 0:
                return value * (MPH_TO_MPS * 3.6 if len(parts) == 2 and parts[1] == "mph" else 1), "tag"
        except ValueError:
            pass
    return DEFAULT_MPH.get(tags.get("highway", ""), 30) * MPH_TO_MPS * 3.6, "default"


def speed_mps(tags: dict) -> float:
    return speed_kmh(tags)[0] / 3.6


def lane_count(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except (ValueError, TypeError):
        return None


def build_road_graph(overpass: dict) -> nx.DiGraph:
    """Directed graph over OSM node ids. Two-way ways get an edge in each direction. Edge attributes: length_m, tt_s, highway, name, ref, way_id, seg (SegmentKey, forward index)."""
    g = nx.DiGraph()
    for way in overpass.get("elements", []):
        if way.get("type") != "way":
            continue
        tags = way.get("tags", {})
        nodes = way.get("nodes")
        geom = way.get("geometry")
        if not nodes or not geom or len(nodes) != len(geom):
            continue
        oneway = tags.get("oneway")
        if oneway == "-1":
            nodes = list(reversed(nodes))
            geom = list(reversed(geom))
            oneway = "yes"
        if oneway is None and tags.get("highway") in ("motorway", "motorway_link"):
            oneway = "yes"
        maxspeed, maxspeed_source = speed_kmh(tags)
        v = maxspeed / 3.6
        common = {"highway": tags.get("highway"), "name": tags.get("name"), "ref": tags.get("ref"), "way_id": way["id"]}
        common.update(lanes=lane_count(tags.get("lanes")), lanes_forward=lane_count(tags.get("lanes:forward")), lanes_backward=lane_count(tags.get("lanes:backward")), maxspeed_kmh=maxspeed, maxspeed_source=maxspeed_source)
        for i in range(len(nodes) - 1):
            a, b = nodes[i], nodes[i + 1]
            pa, pb = geom[i], geom[i + 1]
            g.add_node(a, lat=pa["lat"], lon=pa["lon"])
            g.add_node(b, lat=pb["lat"], lon=pb["lon"])
            length = haversine_m(pa["lat"], pa["lon"], pb["lat"], pb["lon"])
            attrs = {"length_m": length, "tt_s": length / v, "seg": SegmentKey(way["id"], i), **common}
            g.add_edge(a, b, **attrs)
            if oneway not in ("yes", "true", "1"):
                g.add_edge(b, a, **attrs)
    return g


def road_background(overpass: dict) -> dict[str, list[list[list[float]]]]:
    """Road polylines grouped by highway class, for drawing a map background.

    There is no tile layer anywhere in this project, so the map is drawn as vectors from the same cached extract the graph was built from. Coordinates are [lat, lon] and rounded to five decimals, about a meter, which is far finer than any map here needs."""
    roads: dict[str, list] = {}
    for way in overpass.get("elements", []):
        if way.get("type") != "way" or not way.get("geometry"):
            continue
        cls = way.get("tags", {}).get("highway")
        if not cls:
            continue
        roads.setdefault(cls, []).append([[round(p["lat"], 5), round(p["lon"], 5)] for p in way["geometry"]])
    return roads
