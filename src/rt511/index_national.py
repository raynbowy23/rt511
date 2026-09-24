"""A national index of every camera the project's sources publish: one lightweight record per camera, used to draw the country-level map and to answer "what is near here" before any region exists.

This reads the same feeds `rt511 catalog` does, once per source rather than once per region, and caches the result. It is the coarsest possible view, position and source only."""

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path

import httpx

from .catalog import plausible
from .feeds import feed_cameras
from .sources import SOURCES, USER_AGENT, Source


@dataclass
class IndexEntry:
    id: int
    source: str
    lat: float
    lon: float


async def _fetch(http: httpx.AsyncClient, source: Source) -> list[IndexEntry]:
    return [IndexEntry(c.id, source.key, round(c.lat, 5), round(c.lon, 5)) for c in await feed_cameras(http, source) if plausible(c.lat, c.lon)]


async def fetch_index(concurrency: int = 4) -> dict[str, list[IndexEntry]]:
    sem = asyncio.Semaphore(concurrency)

    async def one(source: Source) -> tuple[str, list[IndexEntry]]:
        async with sem:
            try:
                return source.key, await _fetch(http, source)
            except Exception as e:  # noqa: BLE001 - one feed being down should not lose the others
                print(f"  {source.key}: {type(e).__name__}")
                return source.key, []

    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=60.0, follow_redirects=True) as http:
        pairs = await asyncio.gather(*(one(s) for s in SOURCES.values()))
    return dict(pairs)


def index_path(root: Path) -> Path:
    return root / "data" / "national_index.json"


def write_index(index: dict[str, list[IndexEntry]], root: Path) -> Path:
    """Stored as parallel arrays per source rather than a list of objects, because twenty thousand `{"id":…,"lat":…}` records is several megabytes of punctuation."""
    payload = {
        "sources": {
            key: {
                "ids": [e.id for e in entries],
                "lat": [e.lat for e in entries],
                "lon": [e.lon for e in entries],
            }
            for key, entries in index.items()
        }
    }
    path = index_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, separators=(",", ":")))
    return path


def load_index(root: Path) -> dict:
    path = index_path(root)
    return json.loads(path.read_text()) if path.exists() else {"sources": {}}
