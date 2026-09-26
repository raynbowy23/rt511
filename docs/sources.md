# Camera sources

The agencies this project reads cameras from, why each one is allowed, and what the code has to know about its feed. Every number here was measured against the live feed, not assumed.

## How a source is chosen

A state is added when its agency's written terms allow a third-party viewer to show its cameras and it publishes a feed for them. Reachable is not the same as permitted: many state sites serve cameras that anyone can load, while their terms limit the content to individual use or say nothing at all. Those are left out.

On 2026-09-22 every state and DC was checked: its traveller-information site, its developer page if any, and the terms on both. Eight came out permitted with a usable feed (California, Iowa, Kentucky, Maine, New Hampshire, Ohio, Oregon, Vermont), about a dozen permit it only after an application or a signed agreement, six forbid it or limit it to personal use, and the rest are silent. The full table, with the terms quoted and every page read, is kept outside the repository.

## Published feeds (the sources the project keeps)

Surveyed 2026-09-22 across all fifty states and DC. The full table, with the terms quoted and the pages read, is kept outside the repository. A source belongs here only if its agency's written terms allow a third-party viewer to show the cameras and it publishes a feed for them. Each one is read by `src/rt511/feeds.py`, one reader per kind of feed, with the field mapping declared in `data/sources.json`.

| Key | Kind | Feed | Cameras | Video | Snapshot refresh | Terms |
| --- | --- | --- | --- | --- | --- | --- |
| `caltrans` | `caltrans` | `cwwp2.dot.ca.gov/data/d{n}/cctv/cctvStatusD{nn}.json`, twelve district files | 3,412 in service | 2,184, open HLS on `wzmedia.dot.ca.gov`, CORS `*` | 5 min | Caltrans Conditions of Use: public domain unless otherwise indicated |
| `iowadot` | `arcgis` | Iowa DOT `Traffic_Cameras_View` FeatureServer layer 0 | 1,251 | 692, open HLS on `video*.iowadot.gov:8888`, CORS `*` | unmeasured, polled at 60 s | CC BY 4.0 |
| `kytc` | `arcgis` | KYTC `trafficCamerasCur_Prd` FeatureServer layer 0 | 247 after filtering | none | unpublished; changed every 13 to 22 s when sampled on 2026-09-24. Polled at 60 s, the open camera at 15 s | CC0, stated by KYTC |
| `ohgo` | `ohgo` | OHGO Public API `/api/v1/cameras`, 500 a page, your own key | 1,121, one per camera view | none | 5 s per ODOT, and confirmed by sampling on 2026-09-24. Polled at 60 s, the open camera at 5 s | Public domain per ODOT; a published per-key rate cap, 25 a second when checked |
| `tripcheck` | `tripcheck` | TripCheck API `Cctv/Inventory`, your own key | 1,117 | none | unpublished; changed once in two minutes when sampled on 2026-09-24. Polled at 60 s | Use and circulate with credit, mirroring on your own server, and ODOT's disclaimer repeated |
| `necompass` | `compass` | New England Compass C2C XML, `cctvStatusData` for positions, `cctvSnapshotData` for pictures, per state | 493 across ME, NH, VT | none | about two minutes (73 of 84 Vermont pictures changed in 2.5 min), fetched every 5 min | Use, reproduce and redistribute, acknowledging Tri-State |

What the code has to know about them:

- **Ids are hashed from the image URL.** Neither kind carries an id that is numeric, stable and under the server's ten-million block: Caltrans has none, Iowa's device ids run past ten million and its `COMMON_ID` repeats, and ArcGIS object ids change when a layer is rebuilt.
- **Kentucky's layer mixes owners.** It carries KYTC's statewide cameras under `trimarc.org/images/milestone/`, a handful of Indiana TrafficWise cameras, and dead `trimarc.org/images/snapshots/` paths. KYTC cannot license Indiana's images, so the source table keeps only the milestone prefix. The older `Ky_WebCams_WGS84WM` MapServer is stale and is not used.
- **Kentucky leaves the route field empty on a few cameras** and names the road in the description instead ("I-64 at 9th St"), so a leading route in the name stands in for it.
- **Keys are the user's own and are only used for camera lists.** Ohio and Oregon need a key each user registers for, read from `.env` (`OHIODOT_API`, `OREGONDOT_API`) by the pipeline. The server never sends one, because both states' images are served without a key.
- **Rate caps are written down and enforced.** `max_requests_per_s` in `data/sources.json` is kept by the pipeline when it pages a feed and by the server's client for every image request. Ohio's is 10 a second against ODOT's published 25.
- **Oregon requires mirroring and its disclaimer.** Images are served to the browser from this server's `/api/snap`, never hot-linked, and ODOT's warranty disclaimer is stored verbatim as the source's `notice` and shown with every Oregon camera.
- **The tri-state portal has no per-camera image.** A snapshot document holds every camera in a state, so the server fetches it at most once per poll period, shares it across every camera in that state, and backs off for a minute after a failure. Every snapshot in a document carries the document's own timestamp, not the picture's, so freshness is decided by comparing bytes. Some Vermont pictures carry the VTrans mark inside the image; it is shown as published, since cropping it would alter the data.
- **Nothing here needs a borrowed Referer.** The client sends only the project's User-Agent to these hosts, and California's and Iowa's streams, the only video among these sources, allow any origin, so a browser plays them directly.

## Local sources

Some agencies give a developer key freely but ask for written consent before any public use of their cameras. A source like that can still be read on your own machine once you have a key, without the repository claiming it. Put its entry in `data/local/sources.json`, in the same shape as `data/sources.json` and under a key of its own, and add cities on it with `make add-city` as usual. The city, its catalog and its counts are then written under `data/local/`, which git ignores, and the national index skips the source, so nothing drawn from it can be committed. A local source may not reuse a published source's key; both the pipeline and the server refuse to start if it does.

Several states run the same vendor 511 platform, whose developer API lists every camera in one call at `api/v2/get/cameras`, with your key as a `key` query parameter. The `dev511` feed kind reads it, keeping each enabled view as its own camera along with its stream. Whether a state on that platform can be published depends on its own developer agreement, read one by one, and none is published here yet.

## Camera positions are approximate, sometimes badly

Snapping rejects anything further than 80 m from a road, and that threshold is deliberate rather than conservative. The worst case measured, in a city this project no longer serves, had 16 of 80 cameras with no road within 80 m and their nearest road 110 to 300 m away. They were mostly construction and facility cameras whose published coordinates simply did not sit on the road they watched.

Widening the threshold would make this worse, not better. One such camera named an interstate while the nearest road to its published position was a surface street 141 m away. A larger radius would snap it confidently onto the wrong road and produce a corridor edge that does not exist. An unsnapped camera is still catalogued, still polled and still watchable; it is only absent from the graph, which is the honest outcome when we cannot say where it is.

For comparison, most regions snap with a mean under 20 m and nothing unsnapped at all.

## Politeness

Every request carries an identifying User-Agent naming the project and linking to its repository, and nothing else: no borrowed Referer, no token. Snapshots are polled once per refresh period per camera, scheduled from `Last-Modified` rather than a fixed clock, and a camera serving a placeholder backs off for five minutes. Video is never fetched by the server; the browser loads an agency's open stream only while that camera is open. The Overpass road extract, which comes from volunteer-run infrastructure with its own usage policy, is fetched once per region and cached under `data/`.

## Traffic counts

The scale prior prefers a published annual average daily traffic count to road capacity or class. `rt511 counts --region <key>` joins the source's count layer, named under `counts` in `data/sources.json`, to a built region and writes `data/aadt_<region>.json`. Its attribution travels to the on-screen credits, because a licence like CC BY is only met when the credit is visible.

| Source | Layer | Terms | Matched, measured 2026-09-23 |
| --- | --- | --- | --- |
| `iowadot` | Iowa DOT Traffic Log Book AADT, segments | CC BY 4.0 | Des Moines 44 of 80 cameras, interstate median 80,950 |
| `kytc` | KYTC Traffic Section Middle Third, mainline sections | CC0 | Louisville 28 of 77, interstate median 84,001 |

Two filters keep ramps from lending the interstate their counts, which the first run got wrong: a camera on I-35 came back at 1,760 vehicles a day, the count of a ramp Iowa names "86TH ST, N TO I 35 S", with the mainline's 90,600 half a kilometre away. Iowa ramps are dropped by that naming pattern and Kentucky's by keeping mainline sections only, and a camera that names a route takes a count only from a segment on that route. A camera with no such segment within 150 m keeps its capacity prior rather than borrowing a nearby road's figure, which is why fewer than half match. Caltrans publishes its counts as points, and the layer's own metadata reads "Copyright © State of California" with data "made available to the public solely for informational purposes", which is not a grant to reuse it in a tool, so California cameras keep the capacity prior. Ohio's segment layer was found only as third-party copies, and Vermont's carries no licence, so neither is used.

## Incident feeds

An incident feed is added only for a state whose cameras are shown, because an incident with no camera to put it on is information without a picture. A feed is configured in `data/cad_sources.json` with a parser registered in `server/src/cad.ts`.

| Source | Feed | Terms | Notes |
| --- | --- | --- | --- |
| `ohgo` | OHGO Public API `/api/v1/incidents`, your own key, read every two minutes while an Ohio city is open | Public domain per ODOT, same key and rate cap as the cameras | No report time is published, so a record is dated by when this server first saw it (`undated: first_seen`), which restarts its floor's decay if the server restarts. `RoadStatus: Closed` implies closure; every record is road-relevant, and ODOT's category is shown as its label. |

MTC's 511 SF Bay open-data events, under a licence that permits redistribution, are the next candidate, for the Bay Area.

## Retired sources

The project started on a vendor traveller-information platform shared by fourteen state sites, plus a state highway patrol's dispatch feed and that state's published traffic counts. All three were removed on 2026-09-23. Most of the platform sites publish no developer agreement, their camera list sits on a path their shared robots.txt disallows, one state's terms limit its content to individual use, and several gate their video behind a token and a Referer check meant for their own pages. A published tool should not depend on reading a site in a way its owner has not agreed to. The dispatch feed and traffic counts went with them because there were no longer cameras in that state to put them on.
