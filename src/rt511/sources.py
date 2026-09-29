"""The camera sources this project reads, loaded from `data/sources.json`.

Every source is an agency's own published feed whose written terms allow a third-party viewer to show its cameras. The table lives in JSON rather than in code because the TypeScript server reads the same facts, and a fact duplicated in two languages drifts. Python and TypeScript both load that one file. See `docs/sources.md` for the survey behind the list."""

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

USER_AGENT: str = json.loads((Path(__file__).resolve().parents[2] / "data" / "sources.json").read_text())["user_agent"]
"""The identifying User-Agent on every request, read from the source table so that the pipeline and the server name the project the same way."""
DEFAULT_POLL_PERIOD_S = 60.0
"""Sixty seconds is the polite default until a source's true picture-refresh rate has been measured. Caltrans publishes its own, five minutes, and its entry says so."""


@dataclass(frozen=True)
class Source:
    key: str
    name: str
    base_url: str
    states: tuple[str, ...]
    snapshot_content_type: str
    """What a working camera returns. These sites answer 200 for a camera with no feed and serve a placeholder graphic instead, and the content type is what distinguishes it."""
    video_auth: bool
    """True when the stream needs a token handshake and an origin Referer, which also means a browser cannot play it and it must be proxied."""
    has_video: bool
    """Whether any camera on this site publishes a stream at all. Sampled, not exhaustive; the catalog counts it properly per region."""
    attribution: str
    poll_period_s: float = DEFAULT_POLL_PERIOD_S
    token_url: str | None = None
    notes: str = ""
    kind: str = ""
    """Which reader in `feeds.py` understands this source's feed: `caltrans` or `arcgis`."""
    license: str = ""
    """The terms the agency publishes the cameras under, in words, shown next to the attribution."""
    terms_url: str = ""
    feed: dict = field(default_factory=dict)
    """Where the published feed lives and which of its fields mean what."""
    notice: str = ""
    """Text the agency's terms require to be repeated wherever its cameras are credited, verbatim. Empty when the terms ask for none."""
    max_requests_per_s: float | None = None
    """The most requests a second this project will ever send the source, set at or below whatever the agency publishes."""
    counts: dict = field(default_factory=dict)
    """The agency's published traffic-count layer, its field names, license and attribution, where one is joined. Empty for sources without one."""
    auth: dict = field(default_factory=dict)
    """How a user's own key is found and sent: the environment variable holding it, then either a header and the header's format or a query parameter, and where to register. Empty for sources that need none."""
    local: bool = False
    """True for a source defined in `data/local/sources.json`: one this machine may read, under an arrangement of its own with the agency, that the public repository does not claim. Its cities, catalogs and counts live under `data/local/` too, which git ignores."""

    @property
    def stream_direct(self) -> bool:
        """True when a browser can load the HLS URL itself."""
        return not self.video_auth


LOCAL_DIR = Path(__file__).resolve().parents[2] / "data" / "local"
"""Where this machine keeps what is not published: sources read under a private arrangement with an agency, and the cities, catalogs and counts built from them. Git ignores it."""


def _load() -> dict[str, "Source"]:
    public = json.loads((Path(__file__).resolve().parents[2] / "data" / "sources.json").read_text())["sources"]
    private_path = LOCAL_DIR / "sources.json"
    private = json.loads(private_path.read_text())["sources"] if private_path.exists() else {}
    clash = sorted(set(public) & set(private))
    if clash:
        raise SystemExit(f"data/local/sources.json redefines published sources {clash}; give local sources keys of their own")
    return {
        key: Source(
            key=key,
            name=rec["name"],
            base_url=rec["base_url"],
            states=tuple(rec["states"]),
            snapshot_content_type=rec["snapshot_content_type"],
            video_auth=rec["video_auth"],
            has_video=rec["has_video"],
            attribution=rec["attribution"],
            poll_period_s=rec["poll_period_s"],
            token_url=rec["token_url"],
            notes=rec.get("notes", ""),
            kind=rec["kind"],
            license=rec.get("license", ""),
            terms_url=rec.get("terms_url", ""),
            feed=rec.get("feed", {}),
            notice=rec.get("notice", ""),
            max_requests_per_s=rec.get("max_requests_per_s"),
            auth=rec.get("auth", {}),
            counts=rec.get("counts", {}),
            local=key in private,
        )
        for key, rec in {**public, **private}.items()
    }


SOURCES: dict[str, Source] = _load()

DISCLAIMER: str = json.loads((Path(__file__).resolve().parents[2] / "data" / "sources.json").read_text())["disclaimer"]
"""Shown wherever cameras are shown. Kept in the source table so that the server and the pipeline say exactly the same thing."""

STATE_SOURCE: dict[str, str] = {st: s.key for s in SOURCES.values() for st in s.states}


ROOT = Path(__file__).resolve().parents[2]


def _dotenv(name: str) -> str | None:
    """One variable from the repository's .env, which is gitignored. Read here rather than exported into the process, so that a key is only ever read by the source that needs it."""
    path = ROOT / ".env"
    if not path.exists():
        return None
    for line in path.read_text().splitlines():
        name_, _, value = line.partition("=")
        if name_.strip() == name:
            return value.strip().strip('"').strip("'") or None
    return None


def _key(source: Source) -> str:
    env = source.auth["env"]
    value = os.environ.get(env) or _dotenv(env)
    if not value:
        raise SystemExit(f"{source.name} needs your own API key in {env}. Register at {source.auth['register']} and put {env}=<key> in .env.")
    return value


def auth_headers(source: Source) -> dict[str, str]:
    """The header carrying the user's own key for a source that sends it in a header, or nothing. Each user registers for their own key under the agency's terms; the project never ships one."""
    if not source.auth or "header" not in source.auth:
        return {}
    return {source.auth["header"]: source.auth["format"].format(key=_key(source))}


def auth_params(source: Source) -> dict[str, str]:
    """The query parameter carrying the user's own key, for a source that takes it in the URL, or nothing."""
    if not source.auth or "query" not in source.auth:
        return {}
    return {source.auth["query"]: _key(source)}


def get_source(key: str) -> Source:
    try:
        return SOURCES[key]
    except KeyError:
        raise SystemExit(f"unknown source {key!r}, expected one of {sorted(SOURCES)}") from None


def source_for_state(state: str) -> Source | None:
    key = STATE_SOURCE.get(state.upper())
    return SOURCES[key] if key else None
