# Camera Sources and Terms of Use

This document lists the public feeds rt511 reads, the terms under which each agency publishes them, and what the code has to know about each feed. Every figure here was measured against the live feed rather than assumed.

## Acceptance Criteria

A state is added only when its transportation agency's written terms allow a third-party viewer to show its cameras, and the agency publishes a feed for that purpose. A camera being reachable is not the same as being permitted. Many state sites serve pictures that anyone can load while their terms limit the content to individual use or say nothing at all, and those are left out. So are feeds that would need a private agreement with each user, or reading a site in a way its robots.txt asks automated clients not to.

On 22 September 2026, every state and the District of Columbia was surveyed, covering each traveler-information site, its developer page where there was one, and the terms on both. Eight states came out permitted with a usable feed, namely California, Iowa, Kentucky, Maine, New Hampshire, Ohio, Oregon and Vermont, of which seven are used, since Kentucky was later withdrawn (see [Retired Sources](#retired-sources)). About a dozen permit it only after an application or a signed agreement, six forbid it or limit it to personal use, and the rest are silent. The full table, with the terms quoted and every page read, is kept outside the repository.

---

## Published Feeds

Each feed is read by `src/rt511/feeds.py`, with one reader per kind of feed and the field mapping declared in `data/sources.json`.

| State (key) | Agency and feed | Cameras | Video | Refresh | Terms |
| --- | --- | --- | --- | --- | --- |
| California (`caltrans`) | Caltrans Commercial Wholesale Web Portal (CWWP2), twelve district JSON files at `cwwp2.dot.ca.gov/data/d{n}/cctv/cctvStatusD{nn}.json` | 3,412 in service | 2,184 open HLS streams on `wzmedia.dot.ca.gov`, CORS `*` | Every 5 minutes, as Caltrans publishes | Caltrans Conditions of Use, public domain unless otherwise indicated |
| Iowa (`iowadot`) | Iowa DOT open-data `Traffic_Cameras_View` ArcGIS FeatureServer, layer 0 | 1,251 | 692 open HLS streams on `video*.iowadot.gov:8888`, CORS `*` | Not published, polled every 60 seconds | Creative Commons Attribution 4.0 (CC BY 4.0) |
| Ohio (`ohgo`) | ODOT OHGO Public API, `/api/v1/cameras`, 500 per page, with your own key | 1,121, one per camera view | None, still pictures only | Every 5 seconds per ODOT, confirmed by sampling on 24 September 2026. Polled every 60 seconds on the wall and every 5 seconds for the camera open in the panel | Public domain per ODOT, with a published per-key rate cap of 25 requests a second when checked |
| Oregon (`tripcheck`) | ODOT TripCheck API, `Cctv/Inventory`, with your own key | 1,117 | None, still pictures only | Not published, and changed once in two minutes when sampled on 24 September 2026. Polled every 60 seconds | Use and circulation permitted with credit, mirroring on your own server, and ODOT's disclaimer repeated |
| Maine, New Hampshire, Vermont (`necompass`) | Tri-State's New England Compass C2C XML, `cctvStatusData` for positions and `cctvSnapshotData` for pictures, per state | 493 across the three states | None, still pictures only | About every 2 minutes (73 of 84 Vermont pictures changed in 2.5 minutes), fetched every 5 minutes | Use, reproduction and redistribution permitted, acknowledging Tri-State |

---

## Ingestion Details

- **Ids are hashed from the image address.** No feed carries an id that is numeric, stable and below the server's ten-million block. Caltrans has none, Iowa's device ids run past ten million and its `COMMON_ID` repeats, and ArcGIS object ids change when a layer is rebuilt. Each source then receives its own block of ten million, so Iowa's native id 7961432 becomes 17961432.
- **Keys belong to the user and are used only for camera lists.** Ohio and Oregon need a key that each user registers for, read from `.env` (`OHIODOT_API` and `OREGONDOT_API`) by the pipeline. The server never sends one, because both states serve their images without a key.
- **Rate caps are written down and enforced.** `max_requests_per_s` in `data/sources.json` is respected by the pipeline when it pages a feed and by the server's client for every image request. Ohio's is 10 a second, against ODOT's published 25.
- **Oregon requires mirroring and its disclaimer.** Images are served to the browser from this server's `/api/snap`, never linked directly, and ODOT's warranty disclaimer is stored verbatim as the source's `notice` and shown with every Oregon camera.
- **The Tri-State portal has no per-camera image.** One snapshot document holds every camera in a state, so the server fetches it at most once per poll period, shares it across every camera in that state, and waits a minute after a failure. Every snapshot in a document carries the document's timestamp rather than the picture's, so freshness is decided by comparing bytes. Some Vermont pictures carry the VTrans mark inside the image, and it is shown as published, since cropping it would alter the data.
- **Video goes directly to the browser.** California's and Iowa's streams, the only video among these sources, allow any origin, so the browser plays them directly from the agency, and the server never handles video.
- **No borrowed Referer.** The client sends only the project's User-Agent to these hosts.

Each source also names the IANA `time_zone` that most of its cameras keep, which the night shift uses to show a camera's local time. A city on the edge of a zone, such as one in eastern Oregon, can name its own `time_zone` in `data/regions.json`, which takes precedence.

---

## Local Sources

Some agencies issue a developer key freely but ask for written consent before any public use of their cameras. Such a source can still be read on your own machine once you have a key, without the repository claiming it. Put its entry in `data/local/sources.json`, in the same shape as `data/sources.json` and under a key of its own, and add cities on it with `make add-city` as usual. The city, its catalog and its counts are then written under `data/local/`, which git ignores, and the national index skips the source, so nothing drawn from it can be committed. A local source may not reuse a published source's key, and both the pipeline and the server refuse to start if it does.

Several states run the same vendor 511 platform, whose developer API lists every camera in one call at `api/v2/get/cameras`, with your key as a `key` query parameter. The `dev511` feed kind reads it and keeps each enabled view as its own camera, along with its stream. Whether a state on that platform can be published depends on its own developer agreement, which has to be read state by state, and none is published here yet.

---

## Traffic Counts and Incident Feeds

### Annual average daily traffic

The road-size prior prefers a published annual average daily traffic count to road capacity or road class. `rt511 counts --region <key>` joins the source's count layer, named under `counts` in `data/sources.json`, to a built region and writes `data/aadt_<region>.json`. Its attribution is carried to the on-screen credits, because a license like CC BY is met only when the credit is visible.

| Source | Layer | Terms | Matched, measured on 23 September 2026 |
| --- | --- | --- | --- |
| `iowadot` | Iowa DOT Traffic Log Book AADT, segments | CC BY 4.0 | Des Moines, 44 of 80 cameras, interstate median 80,950 |

Two filters keep ramps from lending the interstate their counts, which the first run got wrong. A camera on I-35 came back at 1,760 vehicles a day, the count of a ramp that Iowa names "86TH ST, N TO I 35 S", while the mainline's 90,600 was half a kilometer away. Iowa ramps are now dropped by that naming pattern, a source whose ramps are separate sections can keep mainline sections only through a `where` clause in its count settings, and a camera that names a route takes a count only from a segment on that route. A camera with no such segment within 150 m keeps its capacity prior rather than borrowing a nearby road's figure, which is why fewer than half of the cameras match.

Counts from other states are not used. Caltrans publishes its counts as points, and the layer's own metadata reads "Copyright © State of California", with data "made available to the public solely for informational purposes", which is not a grant to reuse it in a tool. Ohio's segment layer was found only as third-party copies, and Vermont's carries no license.

### Incident records

An incident feed is added only for a state whose cameras are shown, because an incident with no camera to put it on is information without a picture. A feed is configured in `data/cad_sources.json`, with a parser registered in `server/src/cad.ts`.

| Source | Feed | Terms | Notes |
| --- | --- | --- | --- |
| `ohgo` | OHGO Public API `/api/v1/incidents`, with your own key, read every two minutes while an Ohio city is open | Public domain per ODOT, under the same key and rate cap as the cameras | No report time is published, so a record is dated by when this server first saw it (`undated: first_seen`), which restarts its floor's decay if the server restarts. `RoadStatus: Closed` implies a closure. Planned work, meaning ODOT's Repairs/Maintenance category or any construction or work-zone category, is listed but earns no floor, closed or not, and every other record is road-relevant. ODOT's category is shown as its label. |

The 511 SF Bay open-data events published by MTC, under a license that permits redistribution, are the next candidate, for the Bay Area.

---

## Camera Positions

Snapping rejects any camera farther than 80 m from a road, and that threshold is deliberate. The worst case measured, in a city the project no longer serves, had 16 of 80 cameras with no road within 80 m and their nearest road 110 to 300 m away. They were mostly construction and facility cameras whose published coordinates did not sit on the road they watched.

Widening the threshold would make this worse. One such camera named an interstate while the nearest road to its published position was a surface street 141 m away, and a larger radius would have snapped it confidently onto the wrong road and produced a corridor edge that does not exist. An unplaced camera is still cataloged, still polled and still watchable. It is only absent from the graph, which is the honest outcome when its position cannot be trusted. Most regions snap with a mean distance under 20 m and leave nothing unplaced.

---

## Politeness

Every request carries an identifying User-Agent that names the project and links to its repository, and nothing else, with no borrowed Referer and no token. Each server asks each agency for at most one on-screen picture every 5 seconds and one off-screen picture every 10 seconds, never faster than the agency makes new pictures, and every request is conditional. A camera serving a placeholder is left alone for five minutes. Video is never fetched by the server, and the browser loads an agency's open stream only while that camera is open. The Overpass road extract, which comes from volunteer-run infrastructure with its own usage policy, is fetched once per region and cached under `data/`.

---

## Retired Sources

- **A vendor 511 platform shared by fourteen state sites**, together with a state highway patrol's dispatch feed and that state's published traffic counts, was removed on 23 September 2026. Most of the platform's sites publish no developer agreement, their camera list sits on a path that their shared robots.txt disallows, one state's terms limit its content to individual use, and several gate their video behind a token and a Referer check meant for their own pages. A published tool should not depend on reading a site in a way its owner has not agreed to. The dispatch feed and the traffic counts went with the platform, because there were no longer cameras in that state to put them on.
- **Kentucky** was removed on 28 September 2026. KYTC publishes its camera layer, image links included, under CC0, but the pictures themselves are served from `www.trimarc.org`, whose robots.txt asks every automated client to stay off the whole site (`Disallow: /`). A robots file is meant for crawlers and is not a license, and a viewer that loads the image links a data feed hands it is not a crawler, but the file is the host saying it does not want automated fetching, and the project's rule is to have permission rather than an argument that something is allowed. Kentucky's pictures were also the largest of any source, up to 1.75 MB each. It can return if KYTC or TRIMARC confirm that an attributed viewer may fetch them, and the ArcGIS reader with its filter for KYTC's own image path is still in the code.
