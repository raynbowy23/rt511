# rt511

A traffic camera wall built from state transportation agencies' published camera feeds. It opens on a map of the United States showing where cameras are, you pick a city, and you get that city's cameras laid out on its road network. Click one to watch it live.

It reads only agencies whose written terms allow a third-party viewer to show their cameras, through the feeds they publish for that purpose: California, Iowa, Kentucky, Ohio, Oregon, Maine, New Hampshire and Vermont, 7,641 cameras in all. See [Camera sources](#camera-sources) and [Disclaimer](#disclaimer).

## Quickstart

You need Node with pnpm, and Python 3.12 or newer with [uv](https://docs.astral.sh/uv/).

```
make setup     # dependencies, then a road graph for each of the twelve included cities (a few minutes)
make start     # builds the wall and serves it
```

Open http://127.0.0.1:8511 and pick a city. Every included city works without a key. Ohio and Oregon need your own free API key only to refresh their camera lists and, for Ohio, to read incidents; see [Setup](#setup).

## Nothing is recorded

Worth saying first. A tool that watches hundreds of cameras could easily become an archive by accident. This one doesn't:

- **Video is never saved, and never touches the server.** Your browser loads the agency's own stream only while you have that camera open. Close it and the bytes are gone.
- **Snapshots are never saved.** The last few frames per camera are held in memory so you can scrub back a few minutes. Restart the server and they're gone.
- **Nothing is shared.** The server listens on localhost only.

The files on disk are all text, and none of them is a picture: the source table, camera lists read from the agencies' feeds, road geometry from OpenStreetMap, the graphs built from those, and text logs of the scorer's decisions under `out/`. The camera lists, the national index and everything in `out/` can be deleted and rebuilt with the pipeline.

## What it costs to run

Each camera is polled no faster than its agency refreshes it: every five minutes for Caltrans, which publishes that interval, and every minute elsewhere until a source's rate has been measured. Cameras nobody is looking at slow down further. The poller waits on each image's `Last-Modified` rather than ticking on a fixed clock, and only keeps a frame if the bytes changed.

| | |
| --- | --- |
| Snapshot requests | one per camera per refresh period, only for cities someone has open |
| Video | none from the server. The browser loads an agency's open stream only while you have that camera open |
| Disk written | none, apart from text logs under `out/` |

Memory depends on what you run. Road and graph geometry is loaded once per city, roughly 40 MB each, and that's what lets the map draw without a tile server. The frame buffer is cameras times frames times snapshot size, and snapshots run 20 to 200 KB depending on the agency. Use `--ring` to trade replay history for memory; ten frames is about ten minutes.

Drawing costs nothing unless you're dragging the map. That matters for a screen left running. A busy city map takes about 34 ms per frame on a desktop CPU with no GPU, and scales with CPU speed, so a slow machine will feel it while panning and nowhere else.
## Being a good guest

Every request identifies the project and links to this repository in its User-Agent, and carries nothing else: no borrowed Referer, no token. Requests are capped per source. A camera returning a placeholder backs off for five minutes. The OpenStreetMap road extract is downloaded once per city and cached, since Overpass is run by volunteers.
## How it's put together

`docs/architecture.md` has the full picture. In short:

| Directory | Language | Role |
| --- | --- | --- |
| `src/rt511/` | Python | Offline pipeline. Finds cameras, matches them to roads, builds graphs. You run it by hand. |
| `server/` | TypeScript | The web service. Serves the API and proxies video. |
| `web/` | React | The wall itself. |
| `shared/` | TypeScript | Types shared by the server and the wall. |

Python here is a batch tool, not a server. It uses shapely and networkx for geometry and shortest paths, and serves no HTML.

## Setup

```
uv sync
pnpm install
cp .env.example .env
```

Ohio and Oregon need your own free API key, which you register for yourself under each agency's terms: OHGO at https://publicapi.ohgo.com/docs/registration and TripCheck at https://apiportal.odot.state.or.us/. Put them in `.env` as `OHIODOT_API` and `OREGONDOT_API`. They are used to read the camera lists and, for Ohio, the incident feed; images need no key. The project never ships a key, and without one those two states are simply unavailable.

## Running it

```
pnpm start
```

One command. It builds the server and the wall, then serves both on http://127.0.0.1:8511. Ctrl+C stops it and releases the port. You don't have to pick a city.

With no arguments every city you've built is loaded, so the national map and all the city maps work straight away, but **no camera is polled until you open one**. Open a city and its cameras start; leave it and they stop a couple of minutes later. A server nobody is looking at makes no requests at all.

Arguments pass through to the server:

```
pnpm start --regions oakland-ca,des-moines-ia    poll these cities from the start
pnpm start --cameras freeway                only freeway cameras
pnpm start --port 8512                      somewhere else
pnpm start --ring 30                        keep more replay history
```

Naming cities polls them continuously whether or not anyone is watching, which is what you want for a screen left on.

The optional vehicle detector runs as its own process next to the server. It counts vehicles in a frame the zero-motion gate has flagged and hands the count to the arbiter as evidence. It needs the YOLO26 weights in `data/models/` (see [License](#license)):

```
uv sync --extra detector
uv run rt511 detect                         on 127.0.0.1:8513, the GPU when there is one
uv run rt511 detect --device cpu            when the GPU is busy
```

The server looks for it at startup and once a minute after that, so it can be started in either order. Set `RT511_DETECTOR_URL` in `.env` to point elsewhere. Without it, still cameras are asked about exactly as before.

| Command | Does |
| --- | --- |
| `pnpm start` | build, then serve |
| `pnpm serve` | serve without rebuilding |
| `pnpm dev` | Vite with hot reload on 5173 and the API on 8511, together, one Ctrl+C stops both |
| `pnpm build` | build only |
| `pnpm check` | type-check everything |

The `Makefile` wraps all of these and the `uv run rt511` pipeline commands below. Run `make` to list them. `make up` runs the server and the detector together, and `make add-city CITY="Buffalo, NY"` creates, catalogs and builds a city in one step.

`pnpm dev` runs the two processes through `concurrently`, so their output is labelled `api` and `web` and interrupting it takes both down.

## Adding a city

```
uv run rt511 sources
uv run rt511 metros --top 20 --name
uv run rt511 city "Des Moines, IA" --radius 12 --limit 60
uv run rt511 catalog --region des-moines-ia
uv run rt511 build --region des-moines-ia
uv run rt511 counts --region des-moines-ia    # Iowa and Kentucky, where the agency publishes counts
```

`sources` lists the agencies this project reads, what each publishes, and its terms. `metros` shows where cameras actually cluster, so you can pick somewhere worth watching. `city` geocodes the name, works out which source covers that state, keeps the cameras nearest the centre, and saves the region. `catalog` reads their details from the agency's feed and `build` matches them to roads. `counts` joins the agency's published traffic counts, where it publishes them under terms that allow it, so the scorer knows how big each road is from a measurement rather than from road class. A city in a state with no source is refused.

California and Iowa publish open video for many of their cameras. The other states publish stills only.
## Three levels of coverage

These scale very differently, which is why the project doesn't just fetch everything:

| | Scope | Cost |
| --- | --- | --- |
| **Indexed** | every camera's position | one read of each source's feed, refreshed by hand |
| **Catalogued** | one city's cameras in full detail | one read of its source's feed, once |
| **Polled** | cameras being watched now | one request per camera per refresh period, while watched |

Indexing is cheap and complete, so the national map shows every camera the sources publish. Cataloguing is a one-off. Polling is the one that has to stay small. Cities exist to bound it, and so does the road graph, since each city needs a multi-megabyte extract from Overpass.
## The camera graph

Cameras are matched to roads and then to each other, which is what turns a list of cameras into a corridor you can follow.

- **Sites** group cameras within 40 m of each other on the same carriageway. Motorway and surface cameras never share one.
- **Matching is scored, not nearest-wins.** A camera's route number, taken from its roadway field, is the strongest signal available, and it's what separates a mainline camera from the frontage road beside it. Direction codes break the remaining tie between carriageways. Cameras named as an intersection give up their route number and are kept off the mainline, so a camera labelled with the freeway it sits beside does not land on the freeway half a mile away.
- **A site with no direction code sits on both carriageways.** Iowa and Kentucky publish no direction, so a camera would land on whichever side is nearer and consecutive cameras would end up facing opposite ways. When you can't tell which way a camera looks, the honest answer is that it covers the whole cross-section.
- **Edges follow traffic.** Site B follows site A if the shortest path between them passes no other site, comes within 60 m of no other camera, and isn't more than 2.5 times the straight-line distance. Each edge carries its length, free-flow travel time, road classes and geometry.
- **Kinds** are freeway, ramp, street, and nearby. Nearby joins two sites close enough to watch the same place with no way to drive between them: parallel one-way streets a block apart, a freeway camera and the arterial at its interchange, or the two carriageways of a divided highway.
- **Validation** checks direction codes against the carriageway, mile marker order, and how many cameras naming a route ended up on it. A source that publishes no direction codes gets an empty direction check instead of a failure.

Where it stands:

| | Oakland | Des Moines | Louisville | Columbus | Portland | Burlington |
| --- | --- | --- | --- | --- | --- |
| Cameras, sites | 80, 65 | 80, 75 | 77, 75 | 80, 80 | 80, 78 | 9, 6 |
| Routes matched | 51/79 | 70/76 | 72/75 | 28/28 | 37/40 | 9/9 |
| Direction reversed | 1 of 51 | not published | not published | not published | not published | 0 |
| Isolated sites | 6 | 1 | 1 | 0 | 2 | 3 |

Direction codes name the route's signed direction, not a compass bearing, so they sit some way off the carriageway's bearing even when correct: a median of 38° around Oakland. That's why the check only flags a near-reversal.

## Disclaimer

rt511 is an independent, non-commercial, open-source project. It is not affiliated with, endorsed by, or operated by any transportation agency. Camera images and traffic data belong to the agencies credited below and are shown as published, without modification and without any warranty of accuracy, completeness or availability. Images are held in memory only and are never stored or redistributed. Do not use while driving.

The same text is on screen whenever the wall is, and every camera shows the agency it comes from, the terms it is published under, and a link to those terms.

## Camera sources

rt511 reads cameras only from agencies whose published terms allow a third-party viewer to show them, and only through the feeds those agencies publish for the purpose. A state is added when its terms say yes, not when its cameras happen to be reachable.

| State | Agency and feed | Terms | Video |
| --- | --- | --- | --- |
| California | Caltrans Commercial Wholesale Web Portal (CWWP2) | [Public domain unless otherwise indicated](https://dot.ca.gov/conditions-of-use) | open HLS where published |
| Iowa | Iowa DOT open-data Traffic Cameras layer | [CC BY 4.0](https://www.arcgis.com/home/item.html?id=c4063f200a7b4da5826e2ac86c677cf5) | open HLS where published |
| Kentucky | KYTC Traffic Cameras layer, KYTC's own cameras only | [CC0](https://www.arcgis.com/home/item.html?id=54ca2c585b1b4b4dab1e5024f9b9e532) | snapshots only |
| Ohio | ODOT's OHGO Public API, your own key | [Public domain, per ODOT](https://publicapi.ohgo.com/docs/terms-of-use) | snapshots only |
| Oregon | ODOT's TripCheck API, your own key | [Use with credit, mirroring and ODOT's disclaimer](https://www.tripcheck.com/Pages/API) | snapshots only |
| Maine, New Hampshire, Vermont | Tri-State's New England Compass Developer Portal | [Use, reproduce and redistribute, crediting Tri-State](http://nec-por.ne-compass.com/DeveloperPortal/Home/Terms) | snapshots only |

Kentucky's layer also lists a few cameras belonging to Indiana, which KYTC's licence cannot cover, so those are dropped. Oregon's terms require its disclaimer to be repeated wherever its cameras are credited, so it appears in full with every Oregon camera. Ohio's terms cap each key at a published request rate, and this project stays well under it. Maine, New Hampshire and Vermont publish every camera's picture in one document per state, 5 to 10 MB, so the server fetches it at most once every five minutes and only while a city there is open.

States that are not listed either publish no terms permitting a third-party viewer, limit their content to individual use, or grant permission only through an agreement each user would have to apply for. They are left out rather than read in a way their owner has not agreed to.

Road geometry is © OpenStreetMap contributors under the ODbL. State boundaries come from Natural Earth and are public domain. There's deliberately no tile layer anywhere: the volunteer-run OpenStreetMap tile servers aren't meant to be an app's background, so roads are drawn as vectors from the cached extract instead.

Each person runs their own copy on their own machine. Nothing is hosted, and no camera data passes through anyone else.

## License

rt511's own code is released under the MIT License, in `LICENSE`.

That licence covers the code in this repository and nothing it reads. Camera imagery belongs to the state Departments of Transportation that publish it, road geometry is © OpenStreetMap contributors under the ODbL, and state boundaries come from Natural Earth in the public domain, as described above.

The optional vehicle detector is designed to run Ultralytics YOLO26, whose code and model weights are licensed under AGPL-3.0. Those weights are not part of this repository and are never committed. They live in the git-ignored `data/models/` folder, and without them the detector switches itself off and everything else runs exactly as before. If you run rt511 with the YOLO26 weights, that deployment has to meet the AGPL-3.0 terms, which include making the source of the running service available. MIT code can be combined with AGPL code, so this repository's source already satisfies that for an unmodified copy. If you need the whole stack under permissive licences, use a permissively licensed detector in place of YOLO26.

