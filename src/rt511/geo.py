"""Small geodesy helpers. Everything works in a local equirectangular frame in meters around a reference point, which is accurate to well under a meter across a city-sized bbox and keeps shapely happy."""

import math

EARTH_R = 6371008.8


class LocalFrame:
    def __init__(self, lat0: float, lon0: float):
        self.lat0 = lat0
        self.lon0 = lon0
        self.kx = math.cos(math.radians(lat0)) * math.pi / 180 * EARTH_R
        self.ky = math.pi / 180 * EARTH_R

    def to_xy(self, lat: float, lon: float) -> tuple[float, float]:
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky

    def to_latlon(self, x: float, y: float) -> tuple[float, float]:
        return y / self.ky + self.lat0, x / self.kx + self.lon0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial bearing from point 1 to point 2, degrees clockwise from north in [0, 360)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def bearing_diff(a: float, b: float) -> float:
    """Smallest absolute difference between two bearings in degrees."""
    d = abs(a - b) % 360
    return min(d, 360 - d)


def compass_of(bearing: float) -> str:
    """Nearest cardinal direction for a bearing, in the N/E/S/W letters the feeds' direction codes are normalised to."""
    return ["N", "E", "S", "W"][int(((bearing + 45) % 360) // 90)]


DIRECTION_BEARINGS = {"N": 0.0, "E": 90.0, "S": 180.0, "W": 270.0}


def direction_offset(bearing: float, direction: str | None) -> float | None:
    """How far a carriageway's heading is from the compass direction a camera's direction code names, in degrees.

    A direction code is the route's signed direction, not a compass reading. Interstate 190 is signed northbound where the pavement runs west, and New York State Route 5 is signed eastbound where it runs north. So this is a soft signal for choosing between two opposing carriageways, never a hard test: only a difference near 180 degrees means the wrong side of the road was chosen."""
    target = DIRECTION_BEARINGS.get(direction or "")
    return None if target is None else bearing_diff(bearing, target)
