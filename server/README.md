# rt511 server

The web-facing service: the camera poller, the API the wall reads, and the built wall itself. It never fetches video; every source's stream is open and the browser plays it directly. TypeScript on Node, with `sharp` for frame metrics and nothing else.

```
pnpm install   # from the repo root; this is a pnpm workspace
pnpm build
node dist/server/src/index.js --regions oakland-ca,des-moines-ia --port 8511
```

Flags mirror the server: `--regions`, `--port`, `--host`, `--cameras` (`all`, `freeway`, or a comma-separated list of native ids), `--concurrency`, `--ring`, and `--root` for a checkout that is not two directories up.

This service generates nothing. It reads what the Python pipeline writes — `data/sources.json`, `data/regions.json`, `data/cameras_<region>.json`, `data/osm_<region>.json`, `data/national_index.json`, `data/us_states.json`, `data/aadt_<region>.json` where a state publishes counts, `out/graph_<region>.json` — and every one of those is shape-checked as it is loaded, because they cross a language boundary and a renamed field would otherwise surface as an undefined in a draw call. `data/sources.json` is canonical: every measured fact about a source, its terms, its rate cap and any notice its agency requires live there, and nothing about a source is written into this code.

The wire contract is in `../shared`, imported by this server and by `../web`, so the shapes are declared once. Coordinate order is part of that contract: `/api/graph` and `/api/roads` carry `[lat, lon]`, `/api/national` carries GeoJSON `[lon, lat]`, and the two are distinct branded types, so swapping them is a compile error rather than a plausible rotated map.

## What the port had to preserve

These are measured behaviors, not implementation details, and each one cost real observation. They are ported as they were found.

**Poll scheduling is not a clock.** Some image hosts regenerate a snapshot on demand once its cache has expired and stamp `Last-Modified` with the time of the request that regenerated it, so a poll landing even slightly early makes the edge re-cache the stale image for another whole period. The next poll is scheduled at the newest `Last-Modified` plus the source's period plus a four second margin, clamped to at least ten seconds and at most a period plus the margin. A 304 carries no new timestamp, so it retries sparsely. A camera serving the placeholder backs off for five minutes. Cameras start at staggered offsets across the period rather than all at once.

**Freshness is bytes.** The regenerated image is frequently byte-identical because the picture behind it changes more slowly than the cache expires, so a frame is appended only when the bytes change. A new `Last-Modified` is not a new frame.

**A placeholder is not a picture.** An image host can answer 200 with a placeholder graphic for a camera with no feed. What distinguishes it is the content type against `snapshot_content_type` for that source, not the bytes, because a placeholder is often a perfectly valid image.

**Activity is relative to the camera itself.** The latest frame difference is scaled against the median of that camera's own recent differences, `min(1, 0.5 · diff / max(baseline, 0.004))`, once it has three samples. Below that the region's median stands in, which is what makes the wall usable within a minute instead of ten.

**Politeness is per source.** One client per source, a concurrency limit, a request-rate cap where the source's terms publish one (`max_requests_per_s`), and the identifying User-Agent from `sources.json` on every request and nothing else. A bulk source, whose pictures come in one document per state, is fetched at most once per poll period and shared by every camera in that state.

**Streams are the agency's own.** `/api/stream/:id` returns the published URL with `direct: true` and the browser plays it with no proxy involved.

**Global camera ids.** Camera ids are unique only within one source, so each source gets a block of ten million by its position in the sorted source list: Iowa's native id 7961432 is 17961432. Region graphs are renumbered into that space as they are served, sites' camera arrays included.

## Attention

`activity` above is untouched and still means what it always did. Alongside it, `/api/cameras` now carries `attention` and the axes it was built from, scored in `attention.ts` against the design in `../docs/attention.md`: an anomaly term measured against a per-camera hour-of-week profile shrunk towards that same rolling median, a spectacle term scaled by published traffic counts where a count file exists and by road capacity or class everywhere else, and a floor put under a camera by a nearby incident from a configured incident feed that decays with the incident's age. Every constant is in the exported `TUNING` block with the reasoning on each one.

Two things are deliberately inert. The absolute half of the spectacle term is wired and weighted zero, because a mean pixel difference over a thumbnail is not a count of vehicles and nothing in this project measures one yet. And `AMBIGUOUS_ZERO`, which marks a frame that changed by nothing in an hour that usually moves, is recorded and never acted on; `/api/cameras` reports how often it has fired, by hour, so the question of what to do about it can be answered with numbers rather than a guess.

Every ranking writes its top thirty to `out/attention-<date>.jsonl`, one line per camera with every axis, the baseline and its sample count, the scale prior and where it came from, and the incident that set any floor. It rotates by local day, stops at thirty-two megabytes, and is written off the request path.

## The arbiter

`jev.ts` asks TypeSafe's Jev about incidents, never about cameras. An incident is asked about once, cached against the record's own content because the feed publishes no update timestamp, and re-asked only if the dispatcher edits it or ten minutes pass. Four questions go in one call: whether the camera pictures support the report, whether it has probably cleared, how much of a wall it deserves on a four-level rubric, and which camera shows it best, with the corridor's upstream neighbors offered alongside the cameras the record names.

It modulates and never replaces. `incidentFloor` computes the deterministic floor first, and that number is carried on the wire beside the adjusted one as `incident_floor_base`. An answer below its gate does nothing at all, a confident one moves the floor inside bounds `JEV` sets, and the only answer allowed to take a floor away is the model saying the incident has already cleared, which is the answer to a roadblock the feed has been listing since April.

With no `JEV_API` in `.env` none of this runs: no client is constructed, nothing is asked, and every camera gets exactly the floor the arithmetic gives it. The same is true of a timeout, a rate limit, a malformed answer or a key that stops working. Calls are capped per rolling minute and to two in the air at once, so a feed that suddenly lists two hundred incidents trickles rather than floods.

Every call is written to `out/jev-<date>.jsonl` with the state that was sent, the answers, their confidences, the latency and the token counts, under a header line carrying the rubrics themselves, so an answer can be read against the question that produced it. Answers are model output about public data: they are logged and shown, never obeyed.

`pnpm --filter @rt511/server test` builds and runs the scorer's and the arbiter's tests on Node's own test runner, so there is no test framework in the dependency tree. Nothing in them touches the network.
