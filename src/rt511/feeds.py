"""Cameras from agencies that publish them as a feed under written terms: Caltrans's wholesale portal and the ArcGIS layers state agencies release as open data.

These are the only sources the project reads, because they are the ones whose owners say in writing that a third-party viewer may show their cameras. There is one reader per kind of feed. What each field of a feed means is declared in `data/sources.json` rather than here, so that adding a second state that publishes the same kind of layer is a table entry and not a code change.

Every reader returns the same flat record, and the catalog step does the rest exactly as it does for any other source: keep what falls in the region, nearest first, up to its limit."""

import asyncio
import base64
import re
import time
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass
from urllib.parse import quote

import httpx

from .sources import Source, auth_headers

DIRECTIONS = {"north": "N", "east": "E", "south": "S", "west": "W", "nb": "N", "eb": "E", "sb": "S", "wb": "W"}
ARCGIS_PAGE = 1000
"""Records asked for per ArcGIS request. Hosted layers cap a page at somewhere between one and two thousand, and asking for less than the cap keeps the paging loop honest on every server."""
ID_SPACE = 9_999_991
"""Native ids have to stay below the server's per-source block of ten million. A prime modulus spreads the hashes evenly."""


@dataclass
class FeedCamera:
    id: int
    lat: float
    lon: float
    image_url: str
    video_url: str | None
    roadway: str
    direction: str | None
    location: str
    mile_marker: float | None
    system: str


def stable_id(key: str) -> int:
    """A camera id that survives the feed being republished. Neither feed kind carries an id that is both numeric and stable: Caltrans has none, Iowa's device ids run past ten million, and ArcGIS object ids change whenever a layer is rebuilt. The image URL names one camera and does not move, so the id is a hash of it."""
    return zlib.crc32(key.encode()) % ID_SPACE


def _number(value: object) -> float | None:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


LEADING_ROUTE = re.compile(r"^\s*((?:I|IR|US|SR|KY|IA|CA|OH)[\s-]*\d+)\b", re.IGNORECASE)


def _leading_route(text: str) -> str:
    """The route a camera name opens with, as in "I-64 at 9th St". Some layers leave their route field empty for a few cameras and put the road only in the name, and without a route a camera has nothing to find its own carriageway by."""
    match = LEADING_ROUTE.match(text)
    return match.group(1) if match else ""


def _direction(value: object) -> str | None:
    return DIRECTIONS.get(str(value or "").strip().lower())


async def _caltrans(http: httpx.AsyncClient, source: Source) -> list[FeedCamera]:
    out: list[FeedCamera] = []
    for district in source.feed["districts"]:
        r = await http.get(source.feed["url"].format(district=district))
        r.raise_for_status()
        for item in r.json().get("data", []):
            cam = item.get("cctv") or {}
            if cam.get("inService") != "true":
                continue
            loc = cam.get("location") or {}
            image = ((cam.get("imageData") or {}).get("static") or {}).get("currentImageURL") or ""
            lat, lon = _number(loc.get("latitude")), _number(loc.get("longitude"))
            if not image or lat is None or lon is None:
                continue
            video = (cam.get("imageData") or {}).get("streamingVideoURL") or ""
            route = f"{loc.get('route', '')}{loc.get('routeSuffix', '')}".strip()
            out.append(
                FeedCamera(
                    id=stable_id(image),
                    lat=lat,
                    lon=lon,
                    image_url=image,
                    # The portal writes "Not Reported" where a camera has no stream, rather than leaving the field empty.
                    video_url=video if video.startswith("http") else None,
                    roadway=route,
                    direction=_direction(loc.get("direction")),
                    location=loc.get("locationName") or loc.get("nearbyPlace") or route,
                    mile_marker=_number(loc.get("milepost")),
                    system=f"Caltrans District {district}",
                )
            )
    return out


async def _arcgis(http: httpx.AsyncClient, source: Source) -> list[FeedCamera]:
    feed = source.feed
    fields: dict[str, str] = feed["fields"]
    prefixes = tuple(feed.get("image_prefixes") or [])
    out: list[FeedCamera] = []
    offset = 0
    while True:
        params = {
            "where": feed.get("where", "1=1"),
            "outFields": "*",
            "returnGeometry": "true",
            "outSR": "4326",
            "resultOffset": str(offset),
            "resultRecordCount": str(ARCGIS_PAGE),
            "f": "json",
        }
        r = await http.get(f"{feed['layer']}/query", params=params)
        r.raise_for_status()
        body = r.json()
        if "error" in body:
            raise RuntimeError(f"{source.key}: {body['error']}")
        features = body.get("features", [])
        for feature in features:
            attrs = feature.get("attributes") or {}
            geom = feature.get("geometry") or {}
            image = attrs.get(fields["image"]) or ""
            lat, lon = _number(geom.get("y")), _number(geom.get("x"))
            if not image or lat is None or lon is None:
                continue
            # A layer can carry cameras another agency owns, whose images the publisher's licence cannot cover. Only images under the prefixes named in the source table are kept. The match ignores the scheme, because layers mix http and https for the same host.
            if prefixes and not image.replace("http://", "https://", 1).startswith(prefixes):
                continue
            video = attrs.get(fields["video"]) if "video" in fields else None
            location = str(attrs.get(fields["location"]) or "")
            out.append(
                FeedCamera(
                    id=stable_id(image),
                    lat=lat,
                    lon=lon,
                    image_url=image,
                    video_url=video if isinstance(video, str) and video.startswith("http") else None,
                    roadway=str(attrs.get(fields.get("roadway", "")) or "") or _leading_route(location),
                    direction=_direction(attrs.get(fields["direction"])) if "direction" in fields else None,
                    location=location,
                    mile_marker=_number(attrs.get(fields["mile_marker"])) if "mile_marker" in fields else None,
                    system=str(attrs.get(fields["system"]) or source.name) if "system" in fields else source.name,
                )
            )
        if not body.get("exceededTransferLimit") or not features:
            break
        offset += len(features)
    return out


class Pace:
    """Spaces a source's requests so that it is never sent more than its `max_requests_per_s`. Sequential by design: a feed that pages is read one page at a time."""

    def __init__(self, source: Source):
        self.gap = 1.0 / source.max_requests_per_s if source.max_requests_per_s else 0.0
        self.last = 0.0

    async def get(self, http: httpx.AsyncClient, url: str, **kwargs) -> httpx.Response:
        wait = self.last + self.gap - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        self.last = time.monotonic()
        return await http.get(url, **kwargs)


def _host_path(url: str) -> str:
    """An image URL without its scheme or an explicit :443, because OHGO lists some cameras both ways and they are the same camera."""
    return re.sub(r"^https?://", "", url).replace(":443/", "/", 1)


async def _ohgo(http: httpx.AsyncClient, source: Source) -> list[FeedCamera]:
    """OHGO pages its cameras 500 at a time. Every view of a camera is a separate image facing a separate way, so each becomes its own camera."""
    pace = Pace(source)
    headers = auth_headers(source)
    out: list[FeedCamera] = []
    page = 1
    while True:
        r = await pace.get(http, source.feed["url"], params={"page": str(page)}, headers=headers)
        r.raise_for_status()
        body = r.json()
        for cam in body.get("results", []):
            lat, lon = _number(cam.get("latitude")), _number(cam.get("longitude"))
            if lat is None or lon is None:
                continue
            for view in cam.get("cameraViews") or []:
                image = view.get("largeUrl") or view.get("smallUrl") or ""
                if not image:
                    continue
                location = str(cam.get("location") or view.get("mainRoute") or "")
                facing = str(view.get("direction") or "")
                out.append(
                    FeedCamera(
                        id=stable_id(_host_path(image)),
                        lat=lat,
                        lon=lon,
                        image_url=image.replace(":443/", "/", 1),
                        video_url=None,
                        roadway=_leading_route(str(view.get("mainRoute") or location)),
                        direction=_direction(facing),
                        location=f"{location} ({facing})" if facing and facing not in ("View", "PTZ") else location,
                        mile_marker=None,
                        system=source.name,
                    )
                )
        if page >= int(body.get("totalPageCount") or 1):
            break
        page += 1
    return out


async def _tripcheck(http: httpx.AsyncClient, source: Source) -> list[FeedCamera]:
    r = await Pace(source).get(http, source.feed["url"], headers={**auth_headers(source), "Accept": "application/json"})
    r.raise_for_status()
    out: list[FeedCamera] = []
    for cam in r.json().get("CCTVInventoryRequest", []):
        image = cam.get("cctv-url") or ""
        lat, lon = _number(cam.get("latitude")), _number(cam.get("longitude"))
        if not image or lat is None or lon is None:
            continue
        route = str(cam.get("route-id") or "")
        out.append(
            FeedCamera(
                id=stable_id(_host_path(image)),
                lat=lat,
                lon=lon,
                # The inventory lists http URLs that redirect to https. Storing the https form saves a redirect on every poll.
                image_url=image.replace("http://", "https://", 1),
                video_url=None,
                roadway=route,
                direction=None,
                location=str(cam.get("cctv-other") or cam.get("device-name") or route),
                mile_marker=_number(cam.get("milepoint")),
                system=source.name,
            )
        )
    return out


C2C = "{http://its.gov/c2c_icd}"


def compass_image_path(network: str, device: str) -> str:
    """Where the server finds one camera's picture inside its state's bulk snapshot document. Not a URL: the portal publishes no per-camera image, so the server fetches the whole state's document and looks the camera up in it."""
    return f"compass:{network}/{quote(device, safe='')}"


async def _compass(http: httpx.AsyncClient, source: Source) -> list[FeedCamera]:
    """Positions and names come from each state's small status document. The snapshots are fetched by the server, never here."""
    pace = Pace(source)
    out: list[FeedCamera] = []
    for network in source.feed["networks"].values():
        r = await pace.get(http, source.feed["url"], params={"networks": network, "dataTypes": "cctvStatusData"})
        r.raise_for_status()
        for cam in ET.fromstring(r.content).iter(f"{C2C}cctvStatus"):
            device = cam.get("id") or ""
            lat, lon = _number(cam.findtext(f"{C2C}lat")), _number(cam.findtext(f"{C2C}lon"))
            if not device or lat is None or lon is None:
                continue
            path = compass_image_path(network, device)
            roadway = cam.findtext(f"{C2C}equipLoc/{C2C}roadway") or ""
            out.append(
                FeedCamera(
                    id=stable_id(path),
                    # The C2C schema writes coordinates as integer microdegrees.
                    lat=lat / 1e6,
                    lon=lon / 1e6,
                    image_url=path,
                    video_url=None,
                    roadway=roadway,
                    direction=_direction(cam.findtext(f"{C2C}equipLoc/{C2C}direction")),
                    location=(cam.findtext(f"{C2C}name") or device).strip(),
                    mile_marker=None,
                    system=f"{source.name} {network}",
                )
            )
    return out


def compass_snapshots(document: bytes) -> dict[str, bytes]:
    """Every picture in one state's snapshot document, by device id. Used by tests to check the format the server parses."""
    out: dict[str, bytes] = {}
    for snap in ET.fromstring(document).iter(f"{C2C}cctvSnapshot"):
        data = (snap.findtext(f"{C2C}snippet") or "").strip()
        if data:
            out[snap.get("id") or ""] = base64.b64decode(data)
    return out


READERS = {"caltrans": _caltrans, "arcgis": _arcgis, "ohgo": _ohgo, "tripcheck": _tripcheck, "compass": _compass}


async def feed_cameras(http: httpx.AsyncClient, source: Source) -> list[FeedCamera]:
    """Every camera a feed publishes, once each. Two records with the same image are the same camera listed twice, which happens in layers that join a device table to a view table; two different images hashing to one id would be a genuine collision, and the second is dropped with a warning rather than silently overwriting the first."""
    reader = READERS.get(source.kind)
    if reader is None:
        raise SystemExit(f"source {source.key} has kind {source.kind!r}, which no feed reader handles")
    seen: dict[int, str] = {}
    unique: list[FeedCamera] = []
    for cam in await reader(http, source):
        held = seen.get(cam.id)
        if held == cam.image_url:
            continue
        if held is not None:
            print(f"  {source.key}: id collision between {held} and {cam.image_url}, keeping the first")
            continue
        seen[cam.id] = cam.image_url
        unique.append(cam)
    return unique
